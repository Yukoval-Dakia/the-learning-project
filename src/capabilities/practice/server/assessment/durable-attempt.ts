import { eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { EvaluationProvenance } from '@/core/schema/assessment';
import {
  JudgePendingAttemptPayload,
  NativeJudgePendingSubmitInput,
} from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import { assessment_submission, evaluation, evaluation_effective_head, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/server/events/writer';
import { ratingFromCoarseOutcome } from '../judge-rating';
import {
  JUDGE_PENDING_ATTEMPT_ACTION,
  type JudgeRunEnqueueDeps,
  admitJudgeRun,
  enqueueJudgeRun,
  judgeRunJobId,
  refundJudgeRunAdmission,
} from '../judge-run-dispatch';
import type { NativeJudgeRunJobData } from '../judge-run-payload';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../judge-run-status';
import {
  type FormalAttemptCapture,
  commitFormalAttempt,
  prepareFormalAttemptSubmission,
  type previewFormalAttempt,
  recordFormalAttemptCapture,
} from './attempt';
import type { SaveSubmissionRequest } from './submit';

export const NATIVE_JUDGE_RESOLUTION = 'experimental:assessment_judge_resolution';

/** Stable dispatch identity survives a lost HTTP response and queue retention. */
export async function dispatchNativeAttempt(
  db: Db,
  questionId: string,
  request: SaveSubmissionRequest,
  options: {
    enabled: boolean;
    capture: FormalAttemptCapture;
    userRating?: 'again' | 'hard' | 'good';
    requireUnassistedModelEvidence?: boolean;
  },
  deps: JudgeRunEnqueueDeps = {},
) {
  const prepared = await prepareFormalAttemptSubmission(
    db,
    'durable_judge_run',
    questionId,
    request,
  );
  const { submission } = prepared;
  const runId = `judge_native_${submission.submission_id}`;
  const pendingId = `evt_pending_${runId}`;
  const hasModel = prepared.revision.execution_plan.assignments.some(
    (a) =>
      a.executor.kind === 'model_executor' &&
      a.scoring_unit_ids.some((id) => prepared.scopedUnitIds.has(id)),
  );
  let token: number | undefined;
  let job: NativeJudgeRunJobData | null;
  let fresh = false;
  try {
    job = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${runId}))`);
      const [existing] = await tx.select().from(event).where(eq(event.id, pendingId));
      if (existing) {
        const payload = JudgePendingAttemptPayload.parse(existing.payload);
        if (
          payload.caller !== 'native_assessment' ||
          payload.submit.question_id !== questionId ||
          payload.submit.user_rating !== options.userRating ||
          payload.submit.require_unassisted_model_evidence !==
            !!options.requireUnassistedModelEvidence
        ) {
          throw new ApiError('coordinate_mismatch', 'durable operation options changed', 409);
        }
        return { run_id: runId, caller: payload.caller, submit: payload.submit };
      }
      if (!options.enabled || !hasModel) return null;
      token = admitJudgeRun(deps);
      const input = NativeJudgePendingSubmitInput.parse({
        question_id: questionId,
        submission_id: submission.submission_id,
        evaluation_group_id: submission.evaluation_group_id,
        submitted_at: submission.submitted_at,
        expected_head: { expected_effective_id: null, expected_generation: 0 },
        user_rating: options.userRating,
        capture: options.capture,
        require_unassisted_model_evidence: !!options.requireUnassistedModelEvidence,
      });
      const payload = JudgePendingAttemptPayload.parse({
        run_id: runId,
        caller: 'native_assessment',
        knowledge_ids: [],
        ability_global_ids: [],
        submit: input,
      });
      await recordFormalAttemptCapture(
        tx,
        'durable_judge_run',
        questionId,
        submission,
        null,
        options.capture,
      );
      await writeEvent(tx, {
        id: pendingId,
        session_id: options.capture.session_id ?? null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: JUDGE_PENDING_ATTEMPT_ACTION,
        subject_kind: 'question',
        subject_id: questionId,
        outcome: null,
        payload,
        created_at: new Date(submission.submitted_at),
        ingest_at: new Date(submission.submitted_at),
      });
      fresh = true;
      return { run_id: runId, caller: 'native_assessment' as const, submit: input };
    });
  } catch (error) {
    if (token !== undefined) refundJudgeRunAdmission(token, deps);
    throw error;
  }
  if (!job) return null;
  // Replays never create another delivery or consume another admission token.
  if (!fresh) return runId;
  try {
    await enqueueJudgeRun(job, deps, {
      jobId: judgeRunJobId(runId),
      token,
    });
  } catch (error) {
    console.error(
      '[assessment] native answer saved; durable dispatch awaits reconciliation',
      runId,
      error,
    );
    return runId;
  }
  try {
    await writeJobEvent(db, {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.QUEUED,
      payload: { caller: job.caller, question_id: questionId },
    });
  } catch (error) {
    console.error('[assessment] native queued marker failed after durable dispatch', runId, error);
  }
  return runId;
}

/** Queue payload is only a pointer; immutable domain rows own the accepted response. */
export async function executeNativeAttempt(db: Db, job: NativeJudgeRunJobData) {
  const input = NativeJudgePendingSubmitInput.parse(job.submit);
  const [pending] = await db
    .select()
    .from(event)
    .where(eq(event.id, `evt_pending_${job.run_id}`));
  const accepted = JudgePendingAttemptPayload.parse(pending?.payload);
  if (
    accepted.caller !== 'native_assessment' ||
    accepted.run_id !== job.run_id ||
    canonicalHash(accepted.submit) !== canonicalHash(input)
  ) {
    throw new ApiError('coordinate_mismatch', 'queue input differs from accepted operation', 409);
  }
  const [submission] = await db
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, input.submission_id));
  if (
    !submission ||
    submission.evaluation_group_id !== input.evaluation_group_id ||
    submission.submitted_at.toISOString() !== input.submitted_at
  ) {
    throw new ApiError('coordinate_mismatch', 'durable submission coordinates differ', 409);
  }
  const [head] = await db
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, input.evaluation_group_id));
  if (
    (head?.effective_evaluation_id ?? null) !== input.expected_head.expected_effective_id ||
    (head?.generation ?? 0) !== input.expected_head.expected_generation
  ) {
    const [effective] = head?.effective_evaluation_id
      ? await db
          .select()
          .from(evaluation)
          .where(eq(evaluation.evaluation_id, head.effective_evaluation_id))
      : [];
    // Allow recovery of this very operation, but never pay to overwrite a later
    // explicit self-report, manual correction, or appeal.
    if (
      effective?.submission_id !== input.submission_id ||
      EvaluationProvenance.safeParse(effective?.provenance).data?.execution_receipt?.key !==
        `submission:${input.submission_id}`
    ) {
      throw new ApiError('stale_head', 'accepted operation no longer owns the effective head', 409);
    }
  }
  const writeResolution = async (
    tx: Tx,
    prepared: Awaited<ReturnType<typeof previewFormalAttempt>>,
    status: 'effective' | 'review_required',
  ) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.run_id}))`);
    const [existing] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, job.run_id));
    if (existing) return;
    await writeEvent(tx, {
      id: job.run_id,
      session_id: input.capture.session_id ?? null,
      actor_kind: 'agent',
      actor_ref: 'assessment:durable_judge_run',
      action: NATIVE_JUDGE_RESOLUTION,
      subject_kind: 'question',
      subject_id: input.question_id,
      outcome: null,
      caused_by_event_id: `evt_assessment_${input.submission_id}`,
      payload: {
        version: 1,
        status,
        attempt_event_id: `evt_assessment_${input.submission_id}`,
        judge_event_id: null,
        ...(status === 'effective' &&
        (input.user_rating ?? ratingFromCoarseOutcome(prepared.candidate.result.coarse_outcome))
          ? {
              final_rating:
                input.user_rating ??
                ratingFromCoarseOutcome(prepared.candidate.result.coarse_outcome),
            }
          : {}),
        ...prepared.candidate.result,
        assessment: {
          submission_id: input.submission_id,
          evaluation_group_id: input.evaluation_group_id,
          candidate_id: prepared.candidate.evaluation.record.evaluation_id,
          activation_intent: prepared.activation_intent,
        },
      },
    });
  };
  const committed = await commitFormalAttempt(
    db,
    'durable_judge_run',
    input.question_id,
    {
      issuance_id: submission.issuance_id,
      submission_id: submission.submission_id,
      evaluation_group_id: submission.evaluation_group_id,
      idempotency_key: submission.idempotency_key,
      response_set: submission.response_set,
      group_evidence: submission.group_evidence,
      now: submission.submitted_at,
    },
    {
      expectedHead: input.expected_head,
      userRating: input.user_rating,
      capture: input.capture,
      modelAdmission: 'durable',
      requireUnassistedModelEvidence: input.require_unassisted_model_evidence,
      onActivated: async (tx, prepared) => {
        await writeResolution(tx, prepared, 'effective');
      },
    },
  );
  // Held evaluation and recovery of a previously activated candidate have no fresh activation callback.
  await db.transaction((tx) => writeResolution(tx, committed, committed.status));
  return committed;
}
