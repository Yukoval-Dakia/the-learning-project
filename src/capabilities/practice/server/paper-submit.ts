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

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { emitMasteryProgressSignal } from '@/capabilities/notes/server/mastery-progress-signal';
import { enqueueMasteryNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import { scheduleReview } from '@/capabilities/practice/server/fsrs';
import { ratingFromCoarseOutcome } from '@/capabilities/practice/server/judge-rating';
import { newId } from '@/core/ids';
import { validateCauseAgainstProfile } from '@/core/schema/cause';
// YUK-471 Wave 0 (ADR-0044 §3) — FSRS Card type for the snapshot `before`.
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import { db as defaultDb } from '@/db/client';
import type { Db, Tx } from '@/db/client';
import { answer, event, learning_session, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
import { checkRateLimit } from '@/server/http/rate-limit';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/server/judge/route-resolve';
import { recordFamilyObservationForAttempt } from '@/server/mastery/personalized-difficulty';
import {
  PREREQ_RISK_EMIT_ENABLED,
  emitPrereqRiskSignal,
} from '@/server/mastery/prereq-propagation';
import { recordDifficultyCalibrationLabel } from '@/server/mastery/recalibration';
import {
  type ThetaSnapshotEntry,
  getMasteryState,
  updateThetaForAttempt,
} from '@/server/mastery/state';
import { and, desc, eq, gte, isNull, not, sql } from 'drizzle-orm';
import { assertSessionMutable, freezeAnswerDraft } from './answer-draft';
import { writeAttemptSnapshotBrackets } from './attempt-snapshot';
import { enqueueWrongStreakNudge } from './enqueue-wrong-streak-nudge';
import { collectMasteryRefineTargets } from './note-refine-targets';

// The feedback_policy sentinel that buffers feedback until paper completion
// (critic #5). Any other value (incl. the default 'immediate' / unset) → the
// judgement is immediately visible.
export const HIDE_FEEDBACK_POLICY = 'judge_now_show_later' as const;

const PAID_PAPER_JUDGE_ROUTES = new Set([
  'semantic',
  'rubric',
  'steps',
  'multimodal_direct',
  'ai_flexible',
]);
const PAPER_JUDGE_STARTED_ACTION = 'experimental:paper_slot_judge_started';
const PAPER_JUDGE_RELEASED_ACTION = 'experimental:paper_slot_judge_released';
// All paid paper routes are bounded by the task registry at 60s or 90s; the two
// vision routes allow one transient retry, so even their worst case stays below
// three minutes. Five minutes is therefore a crash-recovery lease, not a normal
// in-flight timeout: a live invocation cannot be reclaimed under registry policy.
const PAPER_JUDGE_CLAIM_TTL_MS = 5 * 60_000;

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
  /**
   * YUK-448 — wall-clock RT (ms) from slot reveal to submit. Optional; absent =
   * no RT data. Frozen into the attempt event payload as `duration_ms` (mirrors
   * the solo /api/review/submit path, submit.ts:532). Capture only — NOT fed into
   * θ̂/p(L)/FSRS (ADR-0035 red-line; paper path passes no responseTimeMs).
   */
  latencyMs?: number | null;
}

export interface PaperSubmitSlotResult {
  attemptEventId: string;
  judgeEventId: string;
  answerId: string;
  visibleToUser: boolean;
  coarseOutcome: string;
  score: number | null;
}

async function lockAndReadPaperSlot(tx: Tx, input: PaperSubmitSlotInput, partRef: string | null) {
  const sessionRows = await tx.execute<{
    type: string;
    status: string;
    artifact_id: string | null;
    started_at: string;
  }>(
    sql`SELECT type, status, artifact_id, started_at FROM learning_session WHERE id = ${input.sessionId} FOR UPDATE`,
  );
  const session = (
    sessionRows as unknown as Array<{
      type: string;
      status: string;
      artifact_id: string | null;
      started_at: string;
    }>
  )[0];
  if (!session || session.type !== 'review' || session.artifact_id !== input.paperArtifactId) {
    throw new ApiError('validation_error', 'paper review session binding is invalid', 400);
  }
  if (session.status !== 'started' && session.status !== 'paused') {
    throw new ApiError(
      'validation_error',
      `session ${input.sessionId} is in status '${session.status}' and cannot accept submissions`,
      400,
    );
  }

  const [latestFrozen] = await tx
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

  return { sessionStartedAt: new Date(session.started_at), latestFrozen };
}

/**
 * Persist a short-lived per-slot claim before a paid judge invocation.
 * The advisory lock closes concurrent read→judge races; a current-attempt
 * frozen answer wins idempotently, while changed content is rejected.
 */
async function claimPaidPaperJudge(
  db: Db,
  input: PaperSubmitSlotInput,
  now: Date,
): Promise<PaperSubmitSlotResult | null> {
  const partRef = input.partRef ?? null;
  const inputImageRefs = input.answerImageRefs ?? [];
  return db.transaction(async (tx) => {
    const lockKey = `paper-judge:${input.sessionId}:${input.questionId}:${partRef ?? ''}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const { sessionStartedAt, latestFrozen: frozen } = await lockAndReadPaperSlot(
      tx,
      input,
      partRef,
    );
    const frozenInCurrentAttempt =
      frozen?.submitted_at != null && frozen.submitted_at >= sessionStartedAt;
    if (frozenInCurrentAttempt) {
      const sameContent =
        frozen.content_md === input.answerMd && sameImageRefs(frozen.image_refs, inputImageRefs);
      if (!sameContent || !frozen.event_id) {
        throw new ApiError(
          'conflict',
          `slot (question ${input.questionId}) was already submitted in this session attempt`,
          409,
        );
      }
      const [judge] = await tx
        .select({ id: event.id, payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            eq(event.subject_id, frozen.event_id),
          ),
        )
        .limit(1);
      const payload = judge?.payload as {
        coarse_outcome?: string;
        score?: number;
        visible_to_user?: boolean;
      } | null;
      return {
        attemptEventId: frozen.event_id,
        judgeEventId: judge?.id ?? frozen.event_id,
        answerId: frozen.id,
        visibleToUser: payload?.visible_to_user !== false,
        coarseOutcome: payload?.coarse_outcome ?? 'unsupported',
        score: payload?.score ?? null,
      };
    }

    const [latestClaim] = await tx
      .select({ created_at: event.created_at })
      .from(event)
      .where(
        and(
          eq(event.action, PAPER_JUDGE_STARTED_ACTION),
          eq(event.session_id, input.sessionId),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, input.questionId),
          gte(event.created_at, sessionStartedAt),
          sql`COALESCE(${event.payload}->>'part_ref', '') = ${partRef ?? ''}`,
        ),
      )
      .orderBy(desc(event.created_at))
      .limit(1);
    const [latestRelease] = await tx
      .select({ created_at: event.created_at })
      .from(event)
      .where(
        and(
          eq(event.action, PAPER_JUDGE_RELEASED_ACTION),
          eq(event.session_id, input.sessionId),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, input.questionId),
          gte(event.created_at, sessionStartedAt),
          sql`COALESCE(${event.payload}->>'part_ref', '') = ${partRef ?? ''}`,
        ),
      )
      .orderBy(desc(event.created_at))
      .limit(1);
    const claimIsReleased =
      latestClaim !== undefined &&
      latestRelease !== undefined &&
      latestRelease.created_at.getTime() >= latestClaim.created_at.getTime();
    const claimAgeMs =
      latestClaim && !claimIsReleased ? now.getTime() - latestClaim.created_at.getTime() : null;
    if (claimAgeMs !== null && claimAgeMs < PAPER_JUDGE_CLAIM_TTL_MS) {
      throw new ApiError(
        'paper_judge_in_progress',
        `slot (question ${input.questionId}) already has a recent judge claim`,
        409,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((PAPER_JUDGE_CLAIM_TTL_MS - claimAgeMs) / 1000)),
          ),
        },
      );
    }

    await writeEvent(tx, {
      id: newId(),
      session_id: input.sessionId,
      actor_kind: 'system',
      actor_ref: 'paper_judge',
      action: PAPER_JUDGE_STARTED_ACTION,
      subject_kind: 'question',
      subject_id: input.questionId,
      payload: {
        part_ref: partRef,
        paper_artifact_id: input.paperArtifactId,
        expires_at: new Date(now.getTime() + PAPER_JUDGE_CLAIM_TTL_MS).toISOString(),
      },
      caused_by_event_id: null,
      created_at: now,
    });
    return null;
  });
}

async function releasePaidPaperJudge(db: Db, input: PaperSubmitSlotInput): Promise<void> {
  // Release records operational wall time, intentionally distinct from the
  // submission's captured `now`; it must sort after the claim it compensates.
  const releasedAt = new Date();
  const partRef = input.partRef ?? null;
  await db.transaction(async (tx) => {
    const lockKey = `paper-judge:${input.sessionId}:${input.questionId}:${partRef ?? ''}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await writeEvent(tx, {
      id: newId(),
      session_id: input.sessionId,
      actor_kind: 'system',
      actor_ref: 'paper_judge',
      action: PAPER_JUDGE_RELEASED_ACTION,
      subject_kind: 'question',
      subject_id: input.questionId,
      payload: { part_ref: partRef, released_at: releasedAt.toISOString() },
      caused_by_event_id: null,
      created_at: releasedAt,
    });
  });
}

async function bestEffortReleasePaidPaperJudge(
  db: Db,
  input: PaperSubmitSlotInput,
  originalError: unknown,
): Promise<void> {
  try {
    await releasePaidPaperJudge(db, input);
  } catch (releaseError) {
    // Compensation failure must not replace the rate-limit/provider/DB failure
    // that caused it. The lease remains bounded, and this log keeps both causes.
    console.error('[paper_submit] failed to release paid judge claim', {
      originalError,
      releaseError,
      sessionId: input.sessionId,
      questionId: input.questionId,
      partRef: input.partRef ?? null,
    });
  }
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
  if (preCheckIsSameAttempt) {
    // The current attempt already froze this slot with different content/image.
    // Reject before question/profile resolution or any paid judge call.
    throw new ApiError(
      'conflict',
      `slot (question ${input.questionId}) was already submitted in this session attempt; abandon and reopen the session before changing your answer`,
      409,
    );
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
  // YUK-212 — the route gate pre-resolves on the WHOLE row (q), not the narrowed
  // sub: narrowing only swaps the LLM-facing text (prompt_md / reference_md /
  // structured), never the route-deciding fields (kind / rubric_json / choices_md
  // / image_refs / judge_kind_override), so the gate's route choice is unaffected.
  const resolvedRoute = resolveQuestionJudgeRoute(q, subjectProfile);
  const photoOnlyUnsupported = photoOnly && !IMAGE_CONSUMING_JUDGE_ROUTES.has(resolvedRoute);

  let paidJudgeClaimed = false;
  if (!photoOnlyUnsupported && PAID_PAPER_JUDGE_ROUTES.has(resolvedRoute)) {
    const claimedResult = await claimPaidPaperJudge(db, input, now);
    if (claimedResult) return claimedResult;
    paidJudgeClaimed = true;
    try {
      // Charge the shared budget only after this request owns the paid slot.
      checkRateLimit();
    } catch (err) {
      await bestEffortReleasePaidPaperJudge(db, input, err);
      throw err;
    }
  }

  // Route through the existing judge invoker (Q13: no new capability). Paper
  // judging IS routed, so capability_ref / judge_route are populated (contrast
  // attribution, which leaves them undefined). Skipped entirely for the
  // photo-only unsupported case above (no judge event is written for it).
  const invoked = photoOnlyUnsupported
    ? null
    : await createDefaultJudgeInvoker()
        .invoke({
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
          // YUK-212 + YUK-484(B) — narrow the judge to the submitted sub (the
          // structured node addressed by partRef). null for atomic slots → no-op
          // (whole-row). The invoker narrows text + structured before routing.
          part_ref: partRef,
        })
        .catch(async (err) => {
          if (paidJudgeClaimed) await bestEffortReleasePaidPaperJudge(db, input, err);
          throw err;
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
  // YUK-459 review — guard the post-tx success block against the in-tx race-loser
  // REPLAY path: a concurrent same-content double-submit whose non-locking pre-check
  // missed the freeze re-runs the judge, enters the tx, hits the FOR UPDATE duplicate
  // guard, and `return`s from the callback (writing NO new rows). Without this flag,
  // execution would still fall through to the success block and DOUBLE-emit the
  // mastery_progress 埋点 (polluting the ADR-0040 决定2 Δ distribution). Set true ONLY
  // on the path that actually persists a new attempt; the replay return leaves it false.
  let wroteNewAttempt = false;
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

  const persistSubmission = db.transaction(async (tx) => {
    // Lock and validate the session, then read the latest frozen slot through the
    // same helper used by the paid-judge claim so both paths share one policy.
    const { sessionStartedAt, latestFrozen } = await lockAndReadPaperSlot(tx, input, partRef);
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
    // YUK-471 Wave 0 (ADR-0044 §3) — the PRE-attempt FSRS Card for the slot's subject,
    // retained for the state_snapshot append (null = cold-start → revert deletes row).
    let fsrsBefore: FsrsStateSchemaT | null = null;
    if (!photoOnlyUnsupported) {
      // Per-knowledge FSRS advisory lock (ADR-0028) — serializes read/compute/
      // upsert even across different questions touching the same knowledge.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${fsrsSubjectKind}:${fsrsSubjectId}`}))`,
      );

      let prevStateRow = await getFsrsState(tx, fsrsSubjectKind, fsrsSubjectId);
      // YUK-471 W0 (augment review) — snapshot `before` must reflect the SNAPSHOT SUBJECT
      // row's own existence (null = cold-start → revert DELETEs the row), NOT the legacy
      // question-card fallback below (which only seeds scheduleReview). Captured BEFORE the
      // fallback overwrites prevStateRow — else a knowledge subject whose own row was absent
      // would snapshot a non-null `before` and revert would UPSERT a row that never existed.
      fsrsBefore = prevStateRow?.state ?? null;
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
    //
    // F1 (PR #309 round-4, YUK-215) — write-side representation of "未判分".
    // On the photo-only unsupported path the attempt `outcome` is forced to a
    // valid enum value ('failure', via attemptOutcome above) because the
    // AttemptOnQuestion schema enum is [success|failure|partial] (widening it to
    // 'unanswered' would ripple into the FSRS derivation + the knowledge_mastery
    // view denominator). That enum value is NOT the semantic truth here — the user
    // did not answer wrong, the route simply cannot grade a photo. The SEMANTIC
    // truth is carried by the explicit `unsupported_judge: true` payload flag,
    // which both read-layer right/wrong summaries (practice-read.ts /
    // paper-detail.ts) key on to SKIP the slot (not right, not wrong) and which
    // paper-detail uses to surface outcome='unsupported' to the user. Round-3's
    // fix (no judge event, no FSRS) stopped FSRS pollution; this round stops the
    // read-layer right/wrong pollution that the missing judge event left behind.
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
        // YUK-448 — wall-clock RT, mirroring the solo path (submit.ts:532).
        // Conditional spread keeps the key ABSENT (not null) when no RT data, so
        // the read-side AttemptOnQuestion schema (known.ts:37, `duration_ms:
        // z.number().int().optional()`) parses cleanly — a null would fail it.
        ...(typeof input.latencyMs === 'number' ? { duration_ms: input.latencyMs } : {}),
        // Only stamped on the un-judged path; absent (→ undefined) for every
        // normal graded attempt so the read shape is unchanged for them.
        ...(photoOnlyUnsupported ? { unsupported_judge: true } : {}),
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
          // M2 (YUK-316) — 判分反馈入 payload：复盘读路径（paper-detail）透出它，
          // 设计稿复盘逐题的「AI 反馈」即此（与散题 submit 的 judge event 对齐）。
          feedback_md: judgeResult.feedback_md,
          // Round-4 fix #4: signal to the attribution pipeline that this judge is
          // a placeholder ('other' cause, attribution deferred). The skip guard in
          // runAttributionAndWriteJudgeEvent checks !attribution_pending — it will
          // NOT skip this event, allowing the attribution agent to write a real
          // judge event (with a non-placeholder cause) that supersedes via
          // newest-wins (D6).
          attribution_pending: true,
          // YUK-212 + YUK-484(B) — per-sub verdict 落点. Conditional spread keeps
          // the key ABSENT (not null) for atomic slots, so atomic judge events
          // parse byte-identically. Cut-1: observability / addressability only —
          // mastery (above) stays per-KC, NOT fanned out per sub.
          ...(partRef ? { sub_ref: partRef } : {}),
        },
        caused_by_event_id: attemptEventId,
        created_at: now,
      });
    }

    // (c) FSRS upsert on the slot's knowledge (or question fallback). SKIPPED on
    // the photo-only unsupported path — an ungraded answer schedules nothing.
    // `fsrsWrote` is reused by the (e) snapshot append below to decide bracketing:
    // a non-photo `unsupported` answer maps to 'again' (re-judgeable) and DOES overwrite
    // material_fsrs_state here, so its FSRS transition must be snapshot-bracketed even
    // though θ̂ (d) is skipped (YUK-471 W0 invariant: every imperative FSRS overwrite is
    // revertable).
    const fsrsWrote = !photoOnlyUnsupported && scheduled !== null && stateAfter !== null;
    // Re-state the explicit predicate (not `if (fsrsWrote)`) so TS narrows the mutable
    // `let scheduled` / `let stateAfter` inside the block — an aliased boolean const does
    // NOT propagate narrowing to reassignable lets. `fsrsWrote` is still consumed by (e).
    if (!photoOnlyUnsupported && scheduled !== null && stateAfter !== null) {
      await upsertFsrsState(tx, {
        subject_kind: fsrsSubjectKind,
        subject_id: fsrsSubjectId,
        state: stateAfter,
        due_at: scheduled.dueAt,
        last_review_event_id: attemptEventId,
      });
    }

    // (d) B1-W1 (ADR-0035) — θ̂ 在线更新（p(L) 诊断维，与 (c) FSRS R 轴正交）。
    // 门：跳过 (i) photoOnlyUnsupported（照片无法判分）+ (ii) 任何 coarseOutcome
    // ==='unsupported'（judge 路由未注册 / semantic provider 调用失败——可达路径，
    // 见 embedded-check 测试）。FSRS 把 unsupported 当 'again' 是「可重评」妥协
    // （UI 让用户重判），但 θ̂ 诊断维**没有重评回退出口**，把「系统无法判分」当
    // 答错扣 θ̂ 会污染 p(L)——诊断维宁可不更新也不冤枉（review SF-3）。outcome
    // 映射：success=1 / failure=0；partial→1（部分对≈成功证据，保守不扣——占位
    // 语义，Wave2 复盘可细化为 0.5，需扩 updateTheta 签名，本 wave 不扩）。用 slot
    // 的 referencedKnowledgeIds（primary+secondary，无 primary 回落 q.knowledge_ids，
    // 与 FSRS / judge event 同源）。写独立 mastery_state 表——hermetic 不破。
    // YUK-471 Wave 0 — captured inside the θ̂ gate, consumed by the (e) snapshot append
    // below. Empty when θ̂ is skipped (photo-only / unsupported) — those paths still
    // snapshot their FSRS transition (if any) with theta_snapshots: [].
    let thetaSnapshots: ThetaSnapshotEntry[] = [];
    if (!photoOnlyUnsupported && scheduled !== null && coarseOutcome !== 'unsupported') {
      // YUK-361 finding #3 修复 — 在 updateThetaForAttempt **之前**捕获 family primary
      // knowledge（q.knowledge_ids[0]）的 PRE-attempt θ̂。家族残差必须对着作答前的 θ̂
      // 算（mirror state.ts thetaBefore=s.theta 纪律）；下面 updateThetaForAttempt 会把
      // mastery_state.theta_hat 移到 POSTERIOR，故必须先读。注意：family primary 用
      // q.knowledge_ids[0]（family 计数同源），而 updateThetaForAttempt 的 knowledgeIds 用 slot 的
      // referencedKnowledgeIds——两者可能不同 KC，family 的 θ̂ 锚取 q.knowledge_ids[0]
      // 这一个（与 recordFamilyObservationForAttempt 内部回落读的 KC 一致）。冷启 → 0。
      const familyPrimaryKnowledgeId = q.knowledge_ids[0];
      const familyThetaBefore = familyPrimaryKnowledgeId
        ? ((await getMasteryState(tx, familyPrimaryKnowledgeId))?.theta_hat ?? 0)
        : 0;

      const thetaResult = await updateThetaForAttempt(tx, {
        knowledgeIds: referencedKnowledgeIds,
        questionId: input.questionId,
        outcome: attemptOutcome === 'failure' ? 0 : 1,
        difficulty: q.difficulty,
        attemptEventId,
        now,
        // YUK-372 L3 — enable family b_delta composition (NO-OP until the family gate passes).
        kind: q.kind,
        source: q.source,
        // Codex review F2 — family_key 必须用 question 规范 primary（q.knowledge_ids[0]），不是
        // knowledgeIds[0]（= slot 指派 primary，paper 路径可能 ≠ 题 primary）。与 family 写侧
        // （下面 recordFamilyObservationForAttempt 的 familyPrimaryKnowledgeId）+ 选题读侧同键。
        familyPrimaryKnowledgeId,
      });

      // YUK-471 Wave 0 — capture the θ̂ transition for the (e) snapshot append below.
      // The snapshot itself is appended once, after this block, so the non-photo
      // `unsupported` path (FSRS wrote, θ̂ skipped) is also bracketed.
      thetaSnapshots = thetaResult.theta_snapshots;

      // YUK-361 Phase 5 — 家族级 b_personalized 观测（慢尺度，与上面 θ̂ 快尺度正交）。
      // 同 tx（计数与作答一致），best-effort：绝不 fail 上面的 θ̂/FSRS/event 主路径。
      // 门 (a) 在内部判 judge route 客观性：paper judge route = invoked.route，非客观
      // 路由（exact/keyword 之外，含 photo-only 的 null）内部早返不触 DB。
      //
      // finding #3b 修复 — primary knowledge **必须**用 q.knowledge_ids[0]（题目自身的
      // 主 knowledge），而非 slot 的 input.primaryKnowledgeId。因为 family_key 与
      // countDistinctQuestionsInFamily 的 distinct 计数基都按 `knowledge_ids->>0`
      // 取真相（见 personalized-difficulty.ts 文档：canonical = question.knowledge_ids[0]）。
      // 若改用 slot.primaryKnowledgeId（plan 的 slot 指派，可能 ≠ 题的 knowledge_ids[0]），
      // family_key 与 distinct 计数基会指向**不同**的题集 → distinct 门永远数错 / 数不到，
      // 门控失效。review 路径本就传 q.knowledge_ids[0]，此处对齐到同一真相。
      //
      // finding #3 修复 — 传 familyThetaBefore（上面捕获的 PRE-attempt θ̂），不让 hook 读
      // 已被本次作答移动过的 POSTERIOR mastery_state.theta_hat。
      //
      // finding #4 修复 — partial outcome **不折进**家族校准：传 attemptOutcome，hook 内
      // 对 'partial' 早返（部分对对难度估计语义歧义；旧 `partial→1` coerce 会把半对当全对
      // 制造 spurious「家族更易」负残差偏置）。只折干净二分 success(→1)/failure(→0)。
      //
      // finding #4a 修复 — 用 SAVEPOINT（嵌套 tx）隔离家族写：family 语句直接跑在外层
      // tx 上时，任何 DB 级错误（advisory lock 序列化/死锁、statement timeout、并发首插
      // 的 23505 unique-violation、malformed-jsonb cast）会**毒化** PG tx（25P02），
      // 外层 sql.begin 随后整体 rollback + re-throw——θ̂/FSRS/event 全丢，JS 的
      // try/catch 捕到了也救不回（捕 JS 错 ≠ 解毒 PG tx）。tx.transaction(...) 经
      // drizzle 转成 SAVEPOINT，family 写失败只回滚 savepoint，主 attempt 写完整保留可
      // COMMIT。同 Phase 3 telemetry-in-tx bug 同类修复。
      try {
        await tx.transaction(async (sp) => {
          await recordFamilyObservationForAttempt(sp, {
            primaryKnowledgeId: familyPrimaryKnowledgeId,
            questionId: input.questionId,
            kind: q.kind,
            source: q.source,
            difficulty: q.difficulty,
            outcome: attemptOutcome === 'failure' ? 0 : 1,
            attemptOutcome,
            judgeRoute: invoked?.route ?? null,
            thetaBefore: familyThetaBefore,
            now,
          });
        });
      } catch (err) {
        console.warn('recordFamilyObservationForAttempt (paper) failed (non-fatal):', err);
      }

      // YUK-361 Phase 6 (Task 11) — active-PPI 难度标签记录（与上面家族观测同纪律，
      // 独立 SAVEPOINT 隔离 tx-abort）。hook 内部：非客观判分（invoked?.route 非
      // exact/keyword，含 photo-only null）/ partial（attemptOutcome='partial' 早返）/
      // 无真 π_i（softmax_mfi selected 观测）→ skip 不写。thetaBefore = familyThetaBefore
      // （PRE-attempt θ̂，与家族 hook 同源；b_label 反推锚定它）。attemptEventId 去重锚。
      try {
        await tx.transaction(async (sp) => {
          await recordDifficultyCalibrationLabel(sp, {
            questionId: input.questionId,
            attemptEventId,
            difficulty: q.difficulty,
            outcome: attemptOutcome === 'failure' ? 0 : 1,
            attemptOutcome,
            judgeRoute: invoked?.route ?? null,
            thetaBefore: familyThetaBefore,
            now,
            // YUK-372 L2 — paper sub-slot 不是 practice_stream_item（paper 走 paper-slot 流程，
            // 题级无 stream_item_id）→ 传 null → hook skip（红线 #2：paper 路径永不挂流 slot 的
            // π_i，正确）。不给 PaperSubmitSlotInput / route Zod body 加 stream_item_id 死字段。
            streamItemId: null,
          });
        });
      } catch (err) {
        console.warn('recordDifficultyCalibrationLabel (paper) failed (non-fatal):', err);
      }
    }

    // (e) YUK-561 S2 (revert-bracket §4.1 / O2 dual-sibling) — A-class snapshot append
    // on the PAPER path (mirrors submit.ts), now as TWO independent sibling brackets
    // (θ̂ + FSRS) so a judge-overturn can revert the θ̂ transition ALONE. Replaces the
    // pre-S2 single snapshot hung off the (irreversible) attempt event. The helper
    // writes each segment iff it moved + upholds the C↔snapshot same-condition write
    // invariant, so it fires exactly on the pre-S2 `fsrsWrote || thetaSnapshots.length`
    // condition (both empty on the photo-only path → nothing written):
    //  - a graded answer moves θ̂ (+ usually FSRS) → both segments;
    //  - a non-photo `unsupported` answer maps to 'again' and overwrites
    //    material_fsrs_state at (c) WITHOUT touching θ̂ (SF-3) → FSRS segment only.
    // MUST be in the OUTER `tx`, NOT a SAVEPOINT (HARD invariant of the attempt). The
    // best-effort family/calibration SAVEPOINTs above touch neither state table, so the
    // snapshot scope is unaffected by being appended after them. `fsrsBefore` was
    // captured before the (c) upsert overwrote it. `ingest_at:now` + deterministic ids
    // (inside the helper) give the outbox opt-out + retried-tx idempotency (§6.7).
    await writeAttemptSnapshotBrackets(tx, {
      attemptEventId,
      sessionId: input.sessionId,
      now,
      thetaSnapshots,
      fsrsSnapshots:
        fsrsWrote && stateAfter !== null
          ? [
              {
                subject_kind: fsrsSubjectKind,
                subject_id: fsrsSubjectId,
                before: fsrsBefore,
                after: stateAfter,
              },
            ]
          : [],
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
    wroteNewAttempt = true; // a new attempt was actually persisted (not a replay).
  });
  try {
    await persistSubmission;
  } catch (err) {
    if (paidJudgeClaimed) await bestEffortReleasePaidPaperJudge(db, input, err);
    throw err;
  }

  // YUK-459 — paper/exam 作答的 success 块，与 solo submit (submit.ts:709) 对齐。paper 路径过去
  // 既不 emit p(L) delta 埋点（ADR-0040 决定2 的 experimental:mastery_progress）也不触发
  // mastery_change note-refine——卷题作答的掌握变化对笔记精炼是死线（solo 单题已接，paper 无）。
  // 在 attempt tx COMMIT **之后**调（getMasteryState / notesForKnowledge 读 POSTERIOR row），
  // best-effort：两个 helper 内部各自吞错、绝不连累已 COMMIT 的 attempt。gate 同 solo：仅 success
  //（attemptOutcome==='success' ⇒ θ̂ 已被本次作答更新，emit 读到真实 Δ；非 success 不发以免读陈值）。
  // `&& wroteNewAttempt`：仅在真持久化了新 attempt 时发——挡住 in-tx 竞态-loser 回放双发（见上）。
  if (attemptOutcome === 'success' && wroteNewAttempt) {
    await emitMasteryProgressSignal({
      db,
      knowledgeIds: q.knowledge_ids,
      questionId: input.questionId,
      attemptEventId,
      now,
    });

    // YUK-729 — go through the shared bounded helper (byte-identical to the solo
    // path submit.ts:757) so this paper fan-out inherits the YUK-694
    // MAX_NOTE_REFINE_FANOUT ceiling. The inline loop this replaced iterated ALL
    // knowledge_ids with an unlimited notesForKnowledge query, enqueuing an
    // unbounded number of paid note_refine jobs from a single paper submit.
    const targetArtifactIds = await collectMasteryRefineTargets(db, q.source_ref, q.knowledge_ids);
    for (const artifactId of targetArtifactIds) {
      await enqueueMasteryNoteRefine({
        db,
        artifactId,
        questionId: input.questionId,
        triggerEventId: attemptEventId,
      });
    }
  }

  // Best-effort wrong-streak evaluation; only a newly persisted attempt may enqueue.
  if (wroteNewAttempt) await enqueueWrongStreakNudge(attemptOutcome, attemptEventId);

  // YUK-455 inc-E — prereq 诊断「向后传播」producer (dark-ship), 与 solo submit (submit.ts) 对齐。
  // 答错 B（paper/exam 路径）→ 沿 prerequisite 边向上找 B 的 transitive 前置 A，EMIT
  // `experimental:prereq_risk` 上调 A 的掌握风险。GATE = PREREQ_RISK_EMIT_ENABLED && failure：
  // flag-off 短路 → BYTE-IDENTICAL（YUK-455 回归锚）。partial 不触发（非干净答错）。
  // `&& wroteNewAttempt`：仅在真持久化了新 attempt 时发——挡 in-tx 竞态-loser 回放双发（同上块）。
  // post-commit / best-effort；红线（ADR-0035）：只 EMIT 独立 event 投影，绝不写 mastery_state。
  if (PREREQ_RISK_EMIT_ENABLED && attemptOutcome === 'failure' && wroteNewAttempt) {
    await emitPrereqRiskSignal({
      db,
      failedKnowledgeIds: q.knowledge_ids,
      questionId: input.questionId,
      attemptEventId,
      now,
    });
  }

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
