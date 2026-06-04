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
import { answer, event, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { scheduleReview } from '@/server/review/fsrs';
import { ratingFromCoarseOutcome } from '@/server/review/judge-rating';
import { and, desc, eq, isNull, not, sql } from 'drizzle-orm';
import { assertSessionMutable, freezeAnswerDraft } from './answer-draft';

// The feedback_policy sentinel that buffers feedback until paper completion
// (critic #5). Any other value (incl. the default 'immediate' / unset) → the
// judgement is immediately visible.
export const HIDE_FEEDBACK_POLICY = 'judge_now_show_later' as const;

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
 */
export async function submitPaperSlot(
  input: PaperSubmitSlotInput,
  db: Db = defaultDb,
): Promise<PaperSubmitSlotResult> {
  const now = new Date();

  // Fix #3: cheap non-locking pre-flight before the expensive judge call.
  // Rejects stale/invalid sessions fast (completed, abandoned, misbound paper)
  // without burning judge capacity. The FOR UPDATE inside the transaction below
  // remains the authoritative TOCTOU guard.
  await assertSessionMutable(db, input.sessionId, input.paperArtifactId);

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

  // Route through the existing judge invoker (Q13: no new capability). Paper
  // judging IS routed, so capability_ref / judge_route are populated (contrast
  // attribution, which leaves them undefined).
  const invoked = await createDefaultJudgeInvoker().invoke({
    db,
    question: q,
    answer_md: input.answerMd,
    subjectProfile,
  });
  const judgeResult = invoked.result;
  const coarseOutcome = judgeResult.coarse_outcome;

  // Map coarse outcome → FSRS rating; 'unsupported' → 'again' (failure) so an
  // un-auto-ratable answer still records a review (the user can re-rate later).
  const rating = ratingFromCoarseOutcome(coarseOutcome) ?? 'again';
  const attemptOutcome: 'success' | 'failure' | 'partial' =
    coarseOutcome === 'correct' ? 'success' : coarseOutcome === 'partial' ? 'partial' : 'failure';

  // FSRS keyed on the slot's primary knowledge (CO §5.6 / ADR-0028). Falls back
  // to the question itself when the slot is unlabeled.
  const fsrsSubjectKind: FsrsSubjectKind = input.primaryKnowledgeId ? 'knowledge' : 'question';
  const fsrsSubjectId = input.primaryKnowledgeId ?? input.questionId;

  // visible_to_user gate (critic #5): the sentinel hides feedback until the
  // paper completes; everything else is immediately visible.
  const visibleToUser = input.feedbackPolicy !== HIDE_FEEDBACK_POLICY;

  let attemptEventId = newId();
  let judgeEventId = newId();
  let frozenAnswerId = '';

  const referencedKnowledgeIds = input.primaryKnowledgeId
    ? [input.primaryKnowledgeId, ...(input.secondaryKnowledgeIds ?? [])]
    : q.knowledge_ids;

  // cause: canonical 'other' fallback (critic #1 — no CauseSchema widening, no
  // embed). validateCauseAgainstProfile coerces primary to the profile's 'other'
  // when present. A later attribution agent writes a NEW judge event that
  // supersedes this via newest-per-slot.
  const cause = validateCauseAgainstProfile(
    {
      primary_category: 'other',
      secondary_categories: [],
      analysis_md: '<paper-submit, attribution deferred>',
      confidence: judgeResult.confidence ?? 0,
    },
    subjectProfile,
  );

  await db.transaction(async (tx) => {
    // Session validation (FOR UPDATE): lock the session row to prevent a concurrent
    // status transition (e.g. session completed between route and here). Validates
    // type='review', artifact_id binding, and status ∈ started|paused.
    const sessRows = await tx.execute<{
      type: string;
      status: string;
      artifact_id: string | null;
    }>(
      sql`SELECT type, status, artifact_id FROM learning_session WHERE id = ${input.sessionId} FOR UPDATE`,
    );
    const sess = (
      sessRows as unknown as Array<{ type: string; status: string; artifact_id: string | null }>
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

    // Fix #1: idempotent resubmit guard — if the slot already has a frozen row
    // with the same content_md, return the existing attempt/judge event ids
    // without writing any new rows. This makes API-level retries and double-sends
    // safe: the second request returns the same ids as the first and records no
    // additional FSRS review, no duplicate events, no extra frozen rows.
    //
    // Content differs → legitimate reopen-resubmit (new content after
    // abandon→reopen): fall through to the normal append path below.
    const partRef = input.partRef ?? null;
    const existingFrozen = await tx
      .select({
        id: answer.id,
        event_id: answer.event_id,
        content_md: answer.content_md,
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
    if (latestFrozen?.event_id && latestFrozen.content_md === input.answerMd) {
      // Same content already frozen — find the judge event for this attempt.
      const judgeRows = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            eq(event.subject_id, latestFrozen.event_id),
          ),
        )
        .limit(1);
      // Return existing ids — no new rows written.
      attemptEventId = latestFrozen.event_id;
      judgeEventId = judgeRows[0]?.id ?? judgeEventId; // fallback keeps the pre-generated id
      frozenAnswerId = latestFrozen.id;
      return; // exit the transaction callback
    }

    // Per-knowledge FSRS advisory lock (ADR-0028) — serializes read/compute/
    // upsert even across different questions touching the same knowledge.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${fsrsSubjectKind}:${fsrsSubjectId}`}))`,
    );

    let prevStateRow = await getFsrsState(tx, fsrsSubjectKind, fsrsSubjectId);
    if (!prevStateRow && fsrsSubjectKind === 'knowledge') {
      prevStateRow = await getFsrsState(tx, 'question', input.questionId);
    }
    const scheduled = scheduleReview(
      prevStateRow?.state
        ? { ...prevStateRow.state, last_review: prevStateRow.state.last_review ?? null }
        : null,
      rating,
      now,
    );
    const stateAfter = {
      ...scheduled.nextState,
      due: scheduled.nextState.due,
      last_review: scheduled.nextState.last_review ?? null,
    };

    // (a) attempt event
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
      },
      caused_by_event_id: attemptEventId,
      created_at: now,
    });

    // (c) FSRS upsert on the slot's knowledge (or question fallback).
    await upsertFsrsState(tx, {
      subject_kind: fsrsSubjectKind,
      subject_id: fsrsSubjectId,
      state: stateAfter,
      due_at: scheduled.dueAt,
      last_review_event_id: attemptEventId,
    });

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
    visibleToUser,
    coarseOutcome,
    score: judgeResult.score ?? null,
  };
}
