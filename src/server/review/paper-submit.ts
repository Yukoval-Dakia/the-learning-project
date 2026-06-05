// U5 (YUK-203, §4.6) — paper per-slot submit: attempt event + INDEPENDENT judge
// event (visible_to_user gate) + FSRS writeback, plus answer-draft freeze.
//
// Distinct from /api/review/submit (the single-question FSRS逐张 flow, which is
// LEFT BYTE-FOR-BYTE UNCHANGED — zero regression). The single-question path
// embeds the judge result on the review event; the PAPER path writes a separate
// judge event so the visibility gate (judge-now/show-later) and the deferred
// attribution agent can layer on it (D6: rejudge = new event, never rewrites
// old; the read layer takes newest-per-slot).
//
// Per-slot submit is UI-sequential (Q6) — one slot per request — so there is no
// batch judge and no advisory-lock contention beyond the natural per-knowledge
// FSRS lock the single-question path already uses (ADR-0028).
//
// Independent judge event shape mirrors the verified precedents attribute.ts /
// auto-enroll.ts: action='judge', subject_kind='event', subject_id = the attempt
// event id, caused_by_event_id = the attempt event id, outcome='success', full
// cause object + D6 stamps. cause is populated with the canonical 'other'
// fallback (NOT a CauseSchema widening — critic #1) passed through
// validateCauseAgainstProfile; a later attribution agent supersedes it.

import { newId } from '@/core/ids';
import { validateCauseAgainstProfile } from '@/core/schema/cause';
import { db as defaultDb } from '@/db/client';
import type { Db } from '@/db/client';
import { answer, event, learning_session, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/server/judge/route-resolve';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { scheduleReview } from '@/server/review/fsrs';
import { ratingFromCoarseOutcome } from '@/server/review/judge-rating';
import { and, desc, eq, isNull, not, sql } from 'drizzle-orm';
import { assertSessionMutable, freezeAnswerDraft } from './answer-draft';

// The feedback_policy sentinel that buffers feedback until paper completion
// (critic #5). Any other value (incl. the default 'immediate' / unset) → the
// judgement is immediately visible.
export const HIDE_FEEDBACK_POLICY = 'judge_now_show_later' as const;

// F3 (PR #309 round-1, YUK-215) — order-sensitive element-wise array equality.
// Image refs now influence the judge verdict, so the same-content idempotency
// guard must compare image_refs too: same text + different photo must NOT
// short-circuit to the old attempt (it would return a stale judgement for an
// answer the judge never actually saw).
function sameImageRefs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface PaperSubmitSlotInput {
  /** the review session running this paper (type='review', linked via artifact_id) */
  sessionId: string;
  /** the paper artifact being taken */
  paperArtifactId: string;
  /** the slot's question */
  questionId: string;
  /** StructuredQuestion.id of the part; null for atomic questions */
  partRef?: string | null;
  /** the learner's answer markdown */
  answerMd: string;
  answerImageRefs?: string[];
  /** the slot's primary knowledge id (from the paper assignment) — drives FSRS */
  primaryKnowledgeId?: string | null;
  secondaryKnowledgeIds?: string[];
  /**
   * the section's feedback_policy; when === HIDE_FEEDBACK_POLICY the judge event
   * is written with visible_to_user:false (feedback buffered until completion).
   */
  feedbackPolicy?: string | null;
}

export interface PaperSubmitSlotResult {
  attemptEventId: string;
  judgeEventId: string;
  answerId: string;
  visibleToUser: boolean;
  coarseOutcome: string;
  score: number | null;
}

/**
 * Submit one paper slot. Writes (a) an attempt event, (b) an independent judge
 * event with the visibility gate + D6 stamps + cause, (c) an FSRS upsert on the
 * slot's primary knowledge, and freezes the answer draft — all in one
 * transaction so the audit trail cannot drift from the FSRS projection.
 *
 * Idempotency: a retry/double-send with the same content returns the existing
 * attempt/judge ids without re-invoking the judge or writing any new rows.
 * Changed content while the session is still in its current attempt (i.e. the
 * slot was frozen AFTER the session's started_at) is rejected with 409 — the
 * caller must abandon→reopen before resubmitting different content.
 */
export async function submitPaperSlot(
  input: PaperSubmitSlotInput,
  db: Db = defaultDb,
): Promise<PaperSubmitSlotResult> {
  const now = new Date();
  const partRef = input.partRef ?? null;

  // Round-3 fix #3 (P2): cheap non-locking pre-flight rejects stale/invalid
  // sessions before any expensive work. The FOR UPDATE inside the transaction
  // below is the authoritative TOCTOU guard.
  await assertSessionMutable(db, input.sessionId, input.paperArtifactId);

  // Round-6 fix #4 (CR 3359820529): read started_at non-locking here so the
  // pre-check can scope same-content idempotency to the current attempt only.
  // After abandon→reopen, a slot with the same answer should append a new attempt
  // (the user is re-submitting in a new attempt). The authoritative FOR UPDATE
  // path inside the transaction below carries the same guard.
  const preCheckSessionRows = await db
    .select({ started_at: learning_session.started_at })
    .from(learning_session)
    .where(eq(learning_session.id, input.sessionId))
    .limit(1);
  const preCheckStartedAt = preCheckSessionRows[0]?.started_at ?? new Date(0);

  // Round-3 fix #1 (P2): check for an already-frozen row with the same content
  // BEFORE invoking the judge, so a duplicate submit never burns LLM capacity.
  // Non-locking read is sufficient here — the transaction below re-checks with
  // FOR UPDATE and is the authoritative path.
  const preCheckFrozen = await db
    .select({
      id: answer.id,
      event_id: answer.event_id,
      content_md: answer.content_md,
      image_refs: answer.image_refs,
      submitted_at: answer.submitted_at,
    })
    .from(answer)
    .where(
      and(
        eq(answer.session_id, input.sessionId),
        eq(answer.question_id, input.questionId),
        sql`COALESCE(${answer.part_ref}, '') = COALESCE(${partRef}, '')`,
        not(isNull(answer.submitted_at)),
      ),
    )
    .orderBy(desc(answer.submitted_at))
    .limit(1);

  const preCheckLatest = preCheckFrozen[0];
  // Round-6 fix #4: idempotency only applies when the frozen row belongs to the
  // current attempt (submitted_at >= started_at). A frozen row from before a
  // reopen (submitted_at < started_at) must NOT trigger the early exit — the
  // user is re-submitting in a new attempt and a new attempt row must be written.
  const preCheckIsSameAttempt =
    preCheckLatest?.submitted_at != null && preCheckLatest.submitted_at >= preCheckStartedAt;
  const inputImageRefs = input.answerImageRefs ?? [];
  if (
    preCheckIsSameAttempt &&
    preCheckLatest?.event_id &&
    preCheckLatest.content_md === input.answerMd &&
    // F3: same text but different photo → not idempotent, re-judge.
    sameImageRefs(preCheckLatest.image_refs, inputImageRefs)
  ) {
    // Same content frozen in the current attempt — look up the existing judge
    // event and return without invoking the judge or entering the write transaction.
    const judgeRows = await db
      .select({
        id: event.id,
        payload: event.payload,
      })
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          eq(event.subject_id, preCheckLatest.event_id),
        ),
      )
      .limit(1);

    const existingJudge = judgeRows[0];
    const payload = existingJudge?.payload as {
      coarse_outcome?: string;
      score?: number;
      visible_to_user?: boolean;
    } | null;
    return {
      attemptEventId: preCheckLatest.event_id,
      judgeEventId: existingJudge?.id ?? preCheckLatest.event_id,
      answerId: preCheckLatest.id,
      visibleToUser: payload?.visible_to_user !== false,
      coarseOutcome: payload?.coarse_outcome ?? 'unsupported',
      score: payload?.score ?? null,
    };
  }

  // Load the question for the judge invoker (same fields /review/submit reads).
  const qRows = await db.select().from(question).where(eq(question.id, input.questionId)).limit(1);
  const q = qRows[0];
  if (!q) {
    throw new ApiError('not_found', `question ${input.questionId} not found`, 404);
  }

  // Resolve the profile for the slot's knowledge (primary first, then question
  // labels) — used for the D6 profile_version stamp + cause validation.
  const slotKnowledgeIds = input.primaryKnowledgeId
    ? [input.primaryKnowledgeId, ...(input.secondaryKnowledgeIds ?? [])]
    : q.knowledge_ids;
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, slotKnowledgeIds);

  // F1 (PR #309 round-3, YUK-215) — photo-only gate, mirroring the single-question
  // /api/review/submit F4 fix. A photo-only answer (empty text + image refs) is
  // only judgeable by an image-consuming route (steps / multimodal_direct); any
  // other route reads the text answer alone and would score the empty string as a
  // wrong answer, polluting FSRS. Resolve the route the invoker WOULD dispatch
  // (same resolver) BEFORE invoking; when photo-only AND the route is text-only,
  // take the no-judge path: record the attempt (the answer IS captured), but do
  // NOT invoke the judge, do NOT write a judge event, and do NOT write FSRS. The
  // slot surfaces coarse_outcome='unsupported' (JudgeResultPanel renders this as
  // "无法判分" / cannot judge), so the user sees that this question type does not
  // support photo-only grading instead of a silent (false) wrong.
  const photoOnly = input.answerMd.trim().length === 0 && (input.answerImageRefs?.length ?? 0) > 0;
  const resolvedRoute = resolveQuestionJudgeRoute(q, subjectProfile);
  const photoOnlyUnsupported = photoOnly && !IMAGE_CONSUMING_JUDGE_ROUTES.has(resolvedRoute);

  // Route through the existing judge invoker (Q13: no new capability). Paper
  // judging IS routed, so capability_ref / judge_route are populated (contrast
  // attribution, which leaves them undefined). Skipped entirely for the
  // photo-only unsupported case above (no judge event is written for it).
  const invoked = photoOnlyUnsupported
    ? null
    : await createDefaultJudgeInvoker().invoke({
        db,
        question: q,
        answer_md: input.answerMd,
        // YUK-215 — pass the learner's handwriting-photo refs to the judge so a
        // photographed answer is judged on what was actually written (not just the
        // typed text). `input.answerImageRefs` is already frozen into the attempt
        // event payload (:425) + supplied by the practice submit route; the invoker
        // input schema already accepts `student_image_refs` (invoker.ts:46) — this
        // was the one missing wire. Optional → no-image submits are unchanged.
        student_image_refs: input.answerImageRefs,
        subjectProfile,
      });
  const judgeResult = invoked?.result ?? null;
  // 'unsupported' for the photo-only no-judge path; otherwise the judge's verdict.
  const coarseOutcome = judgeResult?.coarse_outcome ?? 'unsupported';

  // Map coarse outcome → FSRS rating; 'unsupported' → 'again' (failure) so an
  // un-auto-ratable answer still records a review (the user can re-rate later).
  // Unused on the photoOnlyUnsupported path (FSRS is skipped there).
  const rating = ratingFromCoarseOutcome(coarseOutcome) ?? 'again';
  const attemptOutcome: 'success' | 'failure' | 'partial' =
    coarseOutcome === 'correct' ? 'success' : coarseOutcome === 'partial' ? 'partial' : 'failure';

  // FSRS keyed on the slot's primary knowledge (CO §5.6 / ADR-0028). Falls back
  // to the question itself when the slot is unlabeled.
  const fsrsSubjectKind: FsrsSubjectKind = input.primaryKnowledgeId ? 'knowledge' : 'question';
  const fsrsSubjectId = input.primaryKnowledgeId ?? input.questionId;

  // visible_to_user gate (critic #5): the sentinel hides feedback until the
  // paper completes; everything else is immediately visible. The photo-only
  // unsupported state is ALWAYS visible — it is actionable user feedback ("this
  // question type can't grade a photo"), not a buffered judgement.
  const visibleToUser = photoOnlyUnsupported || input.feedbackPolicy !== HIDE_FEEDBACK_POLICY;

  let attemptEventId = newId();
  // F1 (PR #309 round-3) — on the photo-only unsupported path NO judge event is
  // written, so there is no judge event id. Mirror the idempotent path's
  // convention (judgeEventId falls back to the attempt event id) so the returned
  // id always points at a real row instead of a dangling fresh id.
  let judgeEventId = photoOnlyUnsupported ? attemptEventId : newId();
  let frozenAnswerId = '';
  // Round-4 fix #3: these shadow the loser's locally-computed values when the
  // locked duplicate path reloads the winner's persisted judge payload.
  let persistedCoarseOutcome: string = coarseOutcome;
  let persistedScore: number | null | undefined = judgeResult?.score ?? null;
  let persistedVisibleToUser: boolean = visibleToUser;

  const referencedKnowledgeIds = input.primaryKnowledgeId
    ? [input.primaryKnowledgeId, ...(input.secondaryKnowledgeIds ?? [])]
    : q.knowledge_ids;

  // cause: canonical 'other' fallback (critic #1 — no CauseSchema widening, no
  // embed). validateCauseAgainstProfile coerces primary to the profile's 'other'
  // when present. A later attribution agent writes a NEW judge event that
  // supersedes this via newest-per-slot. Unused on the photoOnlyUnsupported path
  // (no judge event is written there).
  const cause = validateCauseAgainstProfile(
    {
      primary_category: 'other',
      secondary_categories: [],
      analysis_md: '<paper-submit, attribution deferred>',
      confidence: judgeResult?.confidence ?? 0,
    },
    subjectProfile,
  );

  await db.transaction(async (tx) => {
    // Session validation (FOR UPDATE): lock the session row to prevent a concurrent
    // status transition (e.g. session completed between route and here). Validates
    // type='review', artifact_id binding, and status ∈ started|paused.
    // Also reads started_at which serves as the reopen marker (see below).
    const sessRows = await tx.execute<{
      type: string;
      status: string;
      artifact_id: string | null;
      started_at: string;
    }>(
      sql`SELECT type, status, artifact_id, started_at FROM learning_session WHERE id = ${input.sessionId} FOR UPDATE`,
    );
    const sess = (
      sessRows as unknown as Array<{
        type: string;
        status: string;
        artifact_id: string | null;
        started_at: string;
      }>
    )[0];
    if (!sess) {
      throw new ApiError('validation_error', `session ${input.sessionId} not found`, 400);
    }
    if (sess.type !== 'review') {
      throw new ApiError(
        'validation_error',
        `session ${input.sessionId} is not a review session`,
        400,
      );
    }
    if (sess.artifact_id !== input.paperArtifactId) {
      throw new ApiError(
        'validation_error',
        `session ${input.sessionId} is not bound to paper ${input.paperArtifactId}`,
        400,
      );
    }
    if (sess.status !== 'started' && sess.status !== 'paused') {
      throw new ApiError(
        'validation_error',
        `session ${input.sessionId} is in status '${sess.status}' and cannot accept submissions`,
        400,
      );
    }

    // Idempotent resubmit guard (authoritative — FOR UPDATE ensures no concurrent
    // freeze wins between the pre-check above and this point).
    // Same content → return existing ids without writing (pre-check usually catches
    // this first, but the transaction re-confirms under lock).
    //
    // Round-3 fix #2 (P2): changed-content guard (§4.9 plan).
    // `started_at` is reset to now() on every reopenAbandonedReviewSession, so it
    // serves as the reopen marker without any new column:
    //   - frozen row submitted_at < started_at → slot was frozen in a previous
    //     attempt (before the last reopen) → changed content is a legitimate
    //     reopen-resubmit, allow append.
    //   - frozen row submitted_at >= started_at → slot was frozen in THIS attempt
    //     → changed content means the active slot is already answered. The user
    //     must abandon→reopen before changing their answer. Reject 409.
    const sessionStartedAt = new Date(sess.started_at);
    const existingFrozen = await tx
      .select({
        id: answer.id,
        event_id: answer.event_id,
        content_md: answer.content_md,
        image_refs: answer.image_refs,
        submitted_at: answer.submitted_at,
      })
      .from(answer)
      .where(
        and(
          eq(answer.session_id, input.sessionId),
          eq(answer.question_id, input.questionId),
          sql`COALESCE(${answer.part_ref}, '') = COALESCE(${partRef}, '')`,
          not(isNull(answer.submitted_at)),
        ),
      )
      .orderBy(desc(answer.submitted_at))
      .limit(1);

    const latestFrozen = existingFrozen[0];
    if (latestFrozen) {
      // Round-6 fix #4 (CR 3359820529): same-content idempotency only applies when
      // the frozen row belongs to the CURRENT attempt (submitted_at >= started_at).
      // A frozen row from a prior attempt (submitted_at < started_at, i.e. before
      // the last reopen) must NOT trigger the early exit — the user is re-submitting
      // in a new attempt and a new attempt+judge+FSRS row must be written.
      const frozenInCurrentAttempt =
        latestFrozen.submitted_at != null && latestFrozen.submitted_at >= sessionStartedAt;
      if (
        frozenInCurrentAttempt &&
        latestFrozen.event_id &&
        latestFrozen.content_md === input.answerMd &&
        // F3: image refs are part of "same content" — same text + different photo
        // is NOT idempotent (the judge verdict depends on the image).
        sameImageRefs(latestFrozen.image_refs, inputImageRefs)
      ) {
        // Same content already frozen in this attempt (authoritative under lock).
        // Return existing ids — no new rows written (judge was also skipped by
        // the pre-check). Round-4 fix #3: also reload the persisted judge payload
        // so the return value reflects what's in the DB, not the loser's freshly-
        // computed (non-persisted) coarseOutcome/score/visibleToUser.
        const judgeRows = await tx
          .select({ id: event.id, payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.action, 'judge'),
              eq(event.subject_kind, 'event'),
              eq(event.subject_id, latestFrozen.event_id),
            ),
          )
          .limit(1);
        attemptEventId = latestFrozen.event_id;
        const lockedJudge = judgeRows[0];
        judgeEventId = lockedJudge?.id ?? judgeEventId;
        frozenAnswerId = latestFrozen.id;
        if (lockedJudge?.payload) {
          // Overwrite the loser's freshly-computed (non-persisted) values with
          // the winner's persisted judge payload — visible_to_user / coarse_outcome
          // / score may differ when the judge is nondeterministic.
          const p = lockedJudge.payload as {
            coarse_outcome?: string;
            score?: number;
            visible_to_user?: boolean;
          };
          persistedCoarseOutcome = p.coarse_outcome ?? coarseOutcome;
          persistedScore = p.score !== undefined ? p.score : (judgeResult?.score ?? null);
          persistedVisibleToUser = p.visible_to_user !== false;
        }
        return; // exit the transaction callback
      }

      // Different content — check the reopen marker.
      const frozenAt = latestFrozen.submitted_at;
      if (frozenAt && frozenAt >= sessionStartedAt) {
        // Slot was frozen in this session attempt. Changed-content resubmit is
        // only allowed after abandon→reopen (which advances started_at). Reject
        // so the caller must reopen the session before changing their answer.
        throw new ApiError(
          'conflict',
          `slot (question ${input.questionId}) was already submitted in this session attempt; abandon and reopen the session before changing your answer`,
          409,
        );
      }
      // frozenAt < sessionStartedAt: frozen in a prior attempt → allow append.
    }

    // F1 (PR #309 round-3) — the photo-only unsupported path records ONLY the
    // attempt (the answer is captured) and the answer freeze: no judge event, no
    // FSRS lock/read/schedule/upsert. A text-only judge never saw the photo, so
    // there is nothing to grade and nothing to schedule; the slot surfaces
    // coarse_outcome='unsupported' as visible user feedback. The FSRS work below
    // is gated behind `!photoOnlyUnsupported`.
    let scheduled: ReturnType<typeof scheduleReview> | null = null;
    let stateAfter:
      | (ReturnType<typeof scheduleReview>['nextState'] & { last_review: Date | null })
      | null = null;
    if (!photoOnlyUnsupported) {
      // Per-knowledge FSRS advisory lock (ADR-0028) — serializes read/compute/
      // upsert even across different questions touching the same knowledge.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${fsrsSubjectKind}:${fsrsSubjectId}`}))`,
      );

      let prevStateRow = await getFsrsState(tx, fsrsSubjectKind, fsrsSubjectId);
      if (!prevStateRow && fsrsSubjectKind === 'knowledge') {
        prevStateRow = await getFsrsState(tx, 'question', input.questionId);
      }
      scheduled = scheduleReview(
        prevStateRow?.state
          ? { ...prevStateRow.state, last_review: prevStateRow.state.last_review ?? null }
          : null,
        rating,
        now,
      );
      stateAfter = {
        ...scheduled.nextState,
        due: scheduled.nextState.due,
        last_review: scheduled.nextState.last_review ?? null,
      };
    }

    // (a) attempt event — always written (the answer IS captured, even when the
    // photo-only route can't grade it).
    await writeEvent(tx, {
      id: attemptEventId,
      session_id: input.sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: input.questionId,
      outcome: attemptOutcome,
      payload: {
        answer_md: input.answerMd,
        answer_image_refs: input.answerImageRefs ?? [],
        referenced_knowledge_ids: referencedKnowledgeIds,
      },
      caused_by_event_id: null,
      created_at: now,
    });

    // (b) independent judge event — subject_kind='event', subject_id = attempt
    // event id, caused_by → attempt (mirrors attribute.ts / auto-enroll.ts).
    // SKIPPED on the photo-only unsupported path: no judge ran, so writing a
    // judge event would fabricate a verdict the system never produced.
    if (!photoOnlyUnsupported && invoked !== null && judgeResult !== null) {
      await writeEvent(tx, {
        id: judgeEventId,
        session_id: input.sessionId,
        actor_kind: 'agent',
        actor_ref: 'paper_judge',
        action: 'judge',
        subject_kind: 'event',
        subject_id: attemptEventId,
        outcome: 'success',
        payload: {
          cause,
          referenced_knowledge_ids: referencedKnowledgeIds,
          // D6 stamps — paper judging IS routed, so all three are populated.
          profile_version: subjectProfile.version,
          capability_ref: invoked.result.capability_ref,
          judge_route: invoked.route,
          // visibility gate (F1/Q1). Omit when visible (default) to keep the
          // payload minimal + back-compat; set false to buffer feedback.
          ...(visibleToUser ? {} : { visible_to_user: false }),
          // U5 (YUK-203): store judge verdict in payload so page-reload / reveal
          // can reconstruct outcome+score without re-running the judge. D6 not
          // broken — three stamps above are unchanged; these are new fields.
          coarse_outcome: coarseOutcome,
          ...(judgeResult.score != null ? { score: judgeResult.score } : {}),
          // Round-4 fix #4: signal to the attribution pipeline that this judge is
          // a placeholder ('other' cause, attribution deferred). The skip guard in
          // runAttributionAndWriteJudgeEvent checks !attribution_pending — it will
          // NOT skip this event, allowing the attribution agent to write a real
          // judge event (with a non-placeholder cause) that supersedes via
          // newest-wins (D6).
          attribution_pending: true,
        },
        caused_by_event_id: attemptEventId,
        created_at: now,
      });
    }

    // (c) FSRS upsert on the slot's knowledge (or question fallback). SKIPPED on
    // the photo-only unsupported path — an ungraded answer schedules nothing.
    if (!photoOnlyUnsupported && scheduled !== null && stateAfter !== null) {
      await upsertFsrsState(tx, {
        subject_kind: fsrsSubjectKind,
        subject_id: fsrsSubjectId,
        state: stateAfter,
        due_at: scheduled.dueAt,
        last_review_event_id: attemptEventId,
      });
    }

    // Freeze the answer draft (set submitted_at + event_id). Re-submission after
    // abandon→reopen writes a NEW frozen row; this one stays immutable (§4.5).
    const frozen = await freezeAnswerDraft(tx, {
      sessionId: input.sessionId,
      questionId: input.questionId,
      partRef: input.partRef ?? null,
      eventId: attemptEventId,
      inputKind: input.answerImageRefs && input.answerImageRefs.length > 0 ? 'image' : 'text',
      contentMd: input.answerMd,
      imageRefs: input.answerImageRefs ?? [],
      paperArtifactId: input.paperArtifactId,
    });
    frozenAnswerId = frozen.answerId;
  });

  return {
    attemptEventId,
    judgeEventId,
    answerId: frozenAnswerId,
    // Round-4 fix #3: use persisted values (overwritten by locked duplicate path
    // when the loser reached the transaction with a different judge result).
    visibleToUser: persistedVisibleToUser,
    coarseOutcome: persistedCoarseOutcome,
    score: persistedScore ?? null,
  };
}
