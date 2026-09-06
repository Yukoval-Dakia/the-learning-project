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

import { and, desc, eq, gte, isNull, not, sql } from 'drizzle-orm';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  createDefaultJudgeInvoker,
  resolveInvokedExecutionProvenance,
  resolveQuestionJudgeRoute,
} from '@/capabilities/practice/server/judge';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { db as defaultDb } from '@/db/client';
import { answer, event, learning_session } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { checkRateLimit } from '@/server/http/rate-limit';
import { assertSessionMutable } from './answer-draft';
import {
  QuestionEvidenceSnapshotError,
  loadQuestionWithAttemptSnapshot,
} from './question-evidence-snapshot';
import { settlePaperSlotReview } from './review-settlement';

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
   * YUK-448 — cumulative foreground-visible time (ms) for this canonical paper slot.
   * Optional; absent means no timing capture. Frozen into attempt payload.duration_ms.
   * Capture only: never consumed by theta, mastery, SRT credit, or FSRS.
   */
  latencyMs?: number | null;
  /**
   * YUK-784 — 学生自述的解题过程文本（组卷面过程框采集）。Optional；absent/blank 时
   * attempt payload 不带 reasoning_trace 键（byte-identical）。落到
   * AttemptOnQuestion.payload.reasoning_trace（槽位 YUK-562 先行铺），observe-only：
   * 不进 θ̂ / FSRS / 判分（同散题路径 submit.ts 的 YUK-562 条件写入）。
   */
  reasoningTrace?: string | null;
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
  if (session?.type !== 'review' || session.artifact_id !== input.paperArtifactId) {
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

  // Load the exact question row used by the judge together with its immutable
  // child + parent evidence. A concurrent edit cannot split judge input from
  // the snapshot later used to interpret this attempt.
  const loadedQuestion = await loadQuestionWithAttemptSnapshot(db, input.questionId).catch(
    (err) => {
      if (!(err instanceof QuestionEvidenceSnapshotError)) throw err;
      if (err.code === 'question_not_found') {
        throw new ApiError('not_found', `question ${input.questionId} not found`, 404);
      }
      throw new ApiError(
        'question_evidence_unavailable',
        `question ${input.questionId} cannot be submitted because its evidence context is incomplete: ${err.message}`,
        409,
      );
    },
  );
  const q = loadedQuestion.question;
  const questionSnapshot = loadedQuestion.question_snapshot;

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
  // YUK-589 (K1) — stamp off the honest model-attempt signal, NOT route membership.
  // execution present → `invoked`; model attempted but no execution (LLM call /
  // metadata / persist failed) → `historical_unknown`; no model attempted
  // (exact/keyword, or an accelerator-resolved unit_dimension slot) →
  // `deterministic`. No judge invoked (photo-only unsupported path) → null.
  // Shared with submit / rejudge via one resolver.
  let executionProvenance: Awaited<ReturnType<typeof resolveInvokedExecutionProvenance>> | null =
    null;
  if (invoked) {
    executionProvenance = await resolveInvokedExecutionProvenance(db, invoked);
  }
  if (
    !photoOnlyUnsupported &&
    (invoked === null || executionProvenance === null || subjectProfile === null)
  ) {
    throw new ApiError('corrupt_state', 'graded paper settlement is missing judge facts', 500);
  }

  const judgement =
    photoOnlyUnsupported ||
    invoked === null ||
    executionProvenance === null ||
    subjectProfile === null
      ? ({ kind: 'ungraded', reason: 'photo_only_unsupported' } as const)
      : ({
          kind: 'graded',
          invocation: invoked,
          executionProvenance,
          subjectProfile,
        } as const);

  try {
    const settled = await settlePaperSlotReview(db, {
      paper: {
        sessionId: input.sessionId,
        artifactId: input.paperArtifactId,
        partRef,
        feedbackPolicy: input.feedbackPolicy ?? null,
      },
      answerSnapshot: {
        markdown: input.answerMd,
        imageRefs: input.answerImageRefs ?? [],
        question: questionSnapshot,
        ...(typeof input.latencyMs === 'number' ? { latencyMs: input.latencyMs } : {}),
        ...(input.reasoningTrace?.trim() ? { reasoningTrace: input.reasoningTrace } : {}),
      },
      question: q,
      knowledge: {
        primaryId: input.primaryKnowledgeId ?? null,
        secondaryIds: input.secondaryKnowledgeIds ?? [],
      },
      judgement,
      submittedAt: now,
    });
    return {
      attemptEventId: settled.attemptEventId,
      judgeEventId: settled.judgeEventId,
      answerId: settled.answerId,
      visibleToUser: settled.visibleToUser,
      coarseOutcome: settled.coarseOutcome,
      score: settled.score,
    };
  } catch (err) {
    if (paidJudgeClaimed) await bestEffortReleasePaidPaperJudge(db, input, err);
    throw err;
  }
}
