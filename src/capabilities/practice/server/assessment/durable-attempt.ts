import { eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { EvaluationProvenance } from '@/core/schema/assessment';
import type { JudgeReservation } from '@/core/schema/event/judge-operational-events';
import {
  JudgePendingAttemptPayload,
  NativeJudgePendingSubmitInput,
  type NativeJudgePendingSubmitInputT,
} from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import { assessment_submission, evaluation, evaluation_effective_head, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  type JudgeExecution,
  authorizeJudgeSend,
  lockJudgeRun,
  readJudgeControl,
  requireJudgeRunOpen,
  reserveInitialJudgeDelivery,
  startJudgeDelivery,
} from '../judge-operational';
import { ratingFromCoarseOutcome } from '../judge-rating';
import {
  JUDGE_PENDING_ATTEMPT_ACTION,
  type JudgeRunEnqueueDeps,
  admitJudgeRun,
  enqueueJudgeRun,
  judgeRunJobId,
  refundJudgeRunAdmission,
} from '../judge-run-dispatch';
import { projectJudgeRunNotification } from '../judge-run-notification';
import { readJudgeRunPermanent } from '../judge-run-observation';
import type { NativeJudgeRunJobData } from '../judge-run-payload';
import { NativeJudgeResolutionPayload } from '../judge-run-payload';
import { JUDGE_RUN_EVENTS } from '../judge-run-status';
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
  const identity = {
    question_id: questionId,
    submission_id: submission.submission_id,
    evaluation_group_id: submission.evaluation_group_id,
    submitted_at: submission.submitted_at,
    expected_head: { expected_effective_id: null, expected_generation: 0 },
    user_rating: options.userRating,
    require_unassisted_model_evidence: !!options.requireUnassistedModelEvidence,
  } satisfies Omit<NativeJudgePendingSubmitInputT, 'capture'>;
  const readAccepted = (existing: typeof event.$inferSelect): NativeJudgeRunJobData => {
    const payload = JudgePendingAttemptPayload.parse(existing.payload);
    if (payload.caller !== 'native_assessment')
      throw new ApiError('coordinate_mismatch', 'durable operation caller changed', 409);
    // Capture is first-write-wins. Compare the frozen original and execution options,
    // not a retry's capture, current question metadata or materialized effective head.
    const { capture, ...acceptedIdentity } = payload.submit;
    if (
      payload.run_id !== runId ||
      canonicalHash(acceptedIdentity) !== canonicalHash(identity) ||
      existing.id !== pendingId ||
      existing.action !== JUDGE_PENDING_ATTEMPT_ACTION ||
      existing.actor_kind !== 'user' ||
      existing.actor_ref !== 'self' ||
      existing.subject_kind !== 'question' ||
      existing.subject_id !== questionId ||
      existing.session_id !== (capture.session_id ?? null) ||
      existing.outcome !== null ||
      existing.caused_by_event_id !== null ||
      existing.task_run_id !== null ||
      existing.cost_micro_usd !== null ||
      existing.created_at.toISOString() !== identity.submitted_at
    ) {
      throw new ApiError('coordinate_mismatch', 'durable operation identity changed', 409);
    }
    return { run_id: runId, caller: payload.caller, submit: payload.submit };
  };
  const hasModel = prepared.revision.execution_plan.assignments.some(
    (a) =>
      a.executor.kind === 'model_executor' &&
      a.scoring_unit_ids.some((id) => prepared.scopedUnitIds.has(id)),
  );
  let token: number | undefined;
  let job: NativeJudgeRunJobData | null;
  let fresh = false;
  let reservation: JudgeReservation | undefined;
  let sendId: string | undefined;
  try {
    job = await db.transaction(async (tx) => {
      const control = await readJudgeControl(tx, 'share');
      await lockJudgeRun(tx, runId);
      const [existing] = await tx.select().from(event).where(eq(event.id, pendingId));
      if (existing) return readAccepted(existing);
      if (!options.enabled || !hasModel) return null;
      if (control.phase !== 'pg-boss' && control.phase !== 'dbos')
        throw new ApiError('judge_draining', 'Judge admissions are temporarily draining', 503);
      token = admitJudgeRun(deps);
      const input = NativeJudgePendingSubmitInput.parse({
        ...identity,
        capture: options.capture,
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
      reservation = await reserveInitialJudgeDelivery(tx, pendingId, payload, control, new Date());
      sendId = await authorizeJudgeSend(tx, reservation, new Date());
      fresh = true;
      return { run_id: runId, caller: 'native_assessment' as const, submit: input };
    });
  } catch (error) {
    // A lost COMMIT acknowledgement is not rollback. Inspect the deterministic intent under R.
    const existing = await db.transaction(async (tx) => {
      await lockJudgeRun(tx, runId);
      const [row] = await tx.select().from(event).where(eq(event.id, pendingId));
      return row ? readAccepted(row) : null;
    });
    if (existing) return runId;
    if (token !== undefined) refundJudgeRunAdmission(token, deps);
    throw error;
  }
  if (!job) return null;
  // Replays never create another delivery or consume another admission token.
  if (!fresh) return runId;
  if (!reservation || !sendId)
    throw new ApiError('corrupt_state', 'Accepted judge intent has no send receipt', 503);
  try {
    await enqueueJudgeRun(job, deps, {
      jobId: judgeRunJobId(runId),
      token,
      authorization: { database: db, reservation, sendId },
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
    await projectJudgeRunNotification(db, runId, {
      eventType: JUDGE_RUN_EVENTS.QUEUED,
      payload: {
        caller: job.caller,
        question_id: questionId,
        delivery_id: reservation.delivery_id,
      },
    });
  } catch (error) {
    console.error('[assessment] native queued marker failed after durable dispatch', runId, error);
  }
  return runId;
}

/** Queue payload is only a pointer; immutable domain rows own the accepted response. */
export async function executeNativeAttempt(
  db: Db,
  job: NativeJudgeRunJobData,
  execution?: JudgeExecution,
) {
  const authority = execution ?? job.operational;
  if (!authority)
    throw new ApiError(
      'judge_authorization_required',
      'Native execution requires mapped permanent delivery authority',
      409,
    );
  const entry = await startJudgeDelivery(db, authority);
  if (entry === 'completed')
    throw new ApiError(
      'judge_already_completed',
      'Native judge operation is already complete',
      409,
    );
  if (entry !== 'open')
    throw new ApiError('judge_disposed', 'Native judge operation cannot execute', 409);
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
    await lockJudgeRun(tx, job.run_id);
    const candidateId = prepared.candidate.evaluation.record.evaluation_id;
    const wanted = {
      id: job.run_id,
      session_id: input.capture.session_id ?? null,
      actor_kind: 'agent',
      actor_ref: 'assessment:durable_judge_run',
      action: NATIVE_JUDGE_RESOLUTION,
      subject_kind: 'question',
      subject_id: input.question_id,
      outcome: null,
      caused_by_event_id: `evt_assessment_${input.submission_id}`,
      payload: NativeJudgeResolutionPayload.parse({
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
          candidate_id: candidateId,
          // The accepted CAS coordinates stay immutable after the native head advances.
          activation_intent: { evaluation_id: candidateId, ...input.expected_head },
        },
      }),
    } satisfies Parameters<typeof writeEvent>[1];
    const validateReceipt = (receipt: typeof event.$inferSelect | undefined) => {
      if (
        !receipt ||
        receipt.session_id !== wanted.session_id ||
        receipt.actor_kind !== wanted.actor_kind ||
        receipt.actor_ref !== wanted.actor_ref ||
        receipt.action !== wanted.action ||
        receipt.subject_kind !== wanted.subject_kind ||
        receipt.subject_id !== wanted.subject_id ||
        receipt.outcome !== wanted.outcome ||
        receipt.caused_by_event_id !== wanted.caused_by_event_id ||
        receipt.task_run_id !== null ||
        receipt.cost_micro_usd !== null ||
        !NativeJudgeResolutionPayload.safeParse(receipt.payload).success ||
        canonicalHash(receipt.payload) !== canonicalHash(wanted.payload)
      )
        throw new ApiError('coordinate_mismatch', 'Immutable resolution receipt differs', 409);
    };
    const [receipt] = await tx.select().from(event).where(eq(event.id, job.run_id));
    if (receipt) {
      validateReceipt(receipt);
      return;
    }
    const state = await readJudgeRunPermanent(tx, job.run_id);
    if (state.kind === 'resolved') {
      // With no run-id event, resolved means the selector proved exact native
      // activation + settlement. Only that same completion may finish its receipt.
      const completion = state.result.assessment;
      if (
        status !== 'effective' ||
        state.result.status !== 'effective' ||
        completion?.submission_id !== input.submission_id ||
        completion.evaluation_group_id !== input.evaluation_group_id ||
        completion.candidate_id !== candidateId ||
        completion.original_evaluation_id !== candidateId ||
        completion.effective_evaluation_id !== candidateId
      )
        throw new ApiError('coordinate_mismatch', 'Native completion differs from resolution', 409);
    } else {
      await requireJudgeRunOpen(tx, authority);
    }
    await writeEvent(tx, wanted);
    // writeEvent is first-write-wins, so a returned id alone is not a receipt acknowledgement.
    const [saved] = await tx.select().from(event).where(eq(event.id, job.run_id));
    validateReceipt(saved);
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
      judgeExecution: authority,
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
