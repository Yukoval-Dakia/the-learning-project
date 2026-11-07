import { and, eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type ActivateEvaluationIntentT,
  EvaluationProvenance,
  resolveActivationCas,
} from '@/core/schema/assessment';
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
import { lockAssessmentEvaluationGroup } from '@/kernel/locks/assessment-evaluation-group-lock';
import { lockJudgeRun } from '@/kernel/locks/grading';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import {
  type JudgeExecution,
  authorizeJudgeSend,
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
import { JUDGE_RUN_EVENTS, nativeJudgeRunId } from '../judge-run-status';
import { projectAttemptEvidence } from '../review-answer-response';
import {
  type FormalAttemptCapture,
  commitFormalAttempt,
  prepareFormalAttemptSubmission,
  previewFormalAttempt,
  recordFormalAttemptCapture,
} from './attempt';
import { readSealedSelfClaim } from './self-claim';
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
    /** A candidate an earlier synchronous preview sealed: the worker activates exactly it. */
    activationIntent?: ActivateEvaluationIntentT;
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
  const runId = nativeJudgeRunId(submission.submission_id);
  const pendingId = `evt_pending_${runId}`;
  const identity = {
    question_id: questionId,
    submission_id: submission.submission_id,
    evaluation_group_id: submission.evaluation_group_id,
    submitted_at: submission.submitted_at,
    expected_head: {
      expected_effective_id: options.activationIntent?.expected_effective_id ?? null,
      expected_generation: options.activationIntent?.expected_generation ?? 0,
    },
    candidate_id: options.activationIntent?.evaluation_id,
    user_rating: options.userRating,
    require_unassisted_model_evidence: !!options.requireUnassistedModelEvidence,
  } satisfies Omit<NativeJudgePendingSubmitInputT, 'capture'>;
  const readAccepted = (existing: typeof event.$inferSelect): NativeJudgeRunJobData => {
    const payload = JudgePendingAttemptPayload.parse(existing.payload);
    if (payload.caller !== 'native_assessment')
      throw new ApiError('coordinate_mismatch', 'durable operation caller changed', 409);
    // Capture is first-write-wins: compare the frozen original and execution options,
    // not the retry's capture, current question metadata, or materialized head.
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
      await lockAssessmentEvaluationGroup(tx, submission.evaluation_group_id);
      const control = await readJudgeControl(tx, 'share');
      await lockJudgeRun(tx, runId);
      const [existing] = await tx.select().from(event).where(eq(event.id, pendingId));
      if (existing) return readAccepted(existing);
      if (!options.enabled || !hasModel) return null;
      if (control.phase !== 'pg-boss' && control.phase !== 'dbos')
        throw new ApiError('judge_draining', 'Judge admissions are temporarily draining', 503);
      // Same refusal the synchronous commit gives, before an anchor the worker could never settle.
      if (options.activationIntent) {
        const [sealed] = await tx
          .select({ id: evaluation.evaluation_id })
          .from(evaluation)
          .where(
            and(
              eq(evaluation.evaluation_id, options.activationIntent.evaluation_id),
              eq(evaluation.submission_id, submission.submission_id),
            ),
          );
        if (!sealed)
          throw new ApiError(
            'candidate_not_found',
            'commit requires a previously sealed candidate',
            409,
          );
        const [head] = await tx
          .select()
          .from(evaluation_effective_head)
          .where(eq(evaluation_effective_head.evaluation_group_id, submission.evaluation_group_id))
          .for('update');
        if (!head || head.submission_id !== submission.submission_id)
          throw new ApiError('coordinate_mismatch', 'candidate and effective head differ', 409);
        const cas = resolveActivationCas(head, options.activationIntent);
        if (!cas.ok && cas.conflict !== 'already_effective')
          throw new ApiError('cas_conflict', cas.conflict, 409);
      }
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
    // A lost COMMIT acknowledgement is not a rollback; inspect the deterministic intent.
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

/** The queue payload is only a pointer; immutable domain rows own the accepted response. */
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
  let superseded = false;
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
    // Recover this operation, but never pay to overwrite a later explicit self-report,
    // manual correction, or appeal.
    if (
      effective?.submission_id !== input.submission_id ||
      EvaluationProvenance.safeParse(effective?.provenance).data?.execution_receipt?.key !==
        `submission:${input.submission_id}`
    ) {
      superseded = true;
    }
  }
  const writeResolution = async (
    tx: Tx,
    prepared: Awaited<ReturnType<typeof previewFormalAttempt>>,
    status: 'effective' | 'review_required',
  ) => {
    await lockJudgeRun(tx, job.run_id);
    const candidateId = prepared.candidate.evaluation.record.evaluation_id;
    const finalRating =
      status === 'effective'
        ? ratingFromCoarseOutcome(prepared.candidate.result.coarse_outcome)
        : null;
    if (status === 'effective' && finalRating === null)
      throw new ApiError(
        'corrupt_state',
        'effective worker result requires a model-derived rating',
        500,
      );
    // The pending payload is itself a first-write-wins seal of the accepted
    // rating operation (a retry that changes it fails coordinate_mismatch), and
    // the durable commit settles the judge-derived rating without re-sealing
    // user_rating — so the frozen input fills what the receipts never wrote.
    const sealedClaim = await readSealedSelfClaim(
      tx,
      input.submission_id,
      input.evaluation_group_id,
      candidateId,
    );
    const wanted = {
      id: job.run_id,
      session_id: input.capture.session_id ?? null,
      actor_kind: 'agent',
      actor_ref: 'assessment:durable_judge_run',
      action: NATIVE_JUDGE_RESOLUTION,
      subject_kind: 'question',
      subject_id: input.question_id,
      outcome: null,
      caused_by_event_id: assessmentAttemptEventId(input.submission_id),
      payload: NativeJudgeResolutionPayload.parse({
        version: 1,
        status,
        attempt_event_id: assessmentAttemptEventId(input.submission_id),
        judge_event_id: null,
        ...(finalRating ? { final_rating: finalRating } : {}),
        ...prepared.candidate.result,
        evidence: projectAttemptEvidence({
          assistance: prepared.assistance,
          verdict: {
            outcome: prepared.candidate.result.coarse_outcome,
            score: prepared.candidate.result.score,
          },
          self_claim: {
            rating: sealedClaim.rating ?? input.user_rating ?? null,
            confidence: sealedClaim.confidence ?? input.capture.self_confidence ?? null,
          },
        }),
        assessment: {
          submission_id: input.submission_id,
          evaluation_group_id: input.evaluation_group_id,
          candidate_id: candidateId,
          // Accepted CAS coordinates stay immutable after the native head advances.
          activation_intent: { evaluation_id: candidateId, ...input.expected_head },
        },
      }),
    } satisfies Parameters<typeof writeEvent>[1];
    // grading_provenance 由 unit_results.judged_by 纯派生；顶层 feedback_md 由评判
    // 记录与文案常量投影，部署边界两侧只差这段散文也合法。两者都不带独立事实，
    // 剥离后比较；其余字段（含 evidence_json.unit_results 里的单元 feedback）仍逐字节比对。
    const stripDerivedResultFields = (payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return payload;
      const {
        grading_provenance: _derived,
        feedback_md: _copy,
        // Receipts sealed before this field shipped carry none; the read side
        // degrades to "no evidence" instead of minting a mismatch on redeploy.
        evidence: _evidence,
        ...rest
      } = payload as Record<string, unknown>;
      return rest;
    };
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
        canonicalHash(stripDerivedResultFields(receipt.payload)) !==
          canonicalHash(stripDerivedResultFields(wanted.payload))
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
      // With no run-id event, "resolved" means the selector proved exact native activation
      // and settlement; only that same completion may finish the receipt.
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
    // writeEvent is first-write-wins, so a returned id is not a receipt acknowledgement.
    const [saved] = await tx.select().from(event).where(eq(event.id, job.run_id));
    validateReceipt(saved);
  };
  const finishSuperseded = async () => {
    const prepared = await previewFormalAttempt(
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
      undefined,
      {
        candidateId: input.candidate_id,
        modelAdmission: 'durable',
        judgeExecution: authority,
        hold: {
          reason: 'unjudgeable',
          detail: '已有更新的判定，本次作答已保存，未覆盖新结果。',
        },
      },
    );
    await db.transaction(async (tx) => {
      await lockAssessmentEvaluationGroup(tx, input.evaluation_group_id);
      await recordFormalAttemptCapture(
        tx,
        'durable_judge_run',
        input.question_id,
        prepared.submission,
        prepared.candidate.evaluation.record.evaluation_id,
        input.capture,
      );
      await writeResolution(tx, prepared, 'review_required');
    });
    return { ...prepared, status: 'review_required' as const };
  };
  if (superseded) return finishSuperseded();
  let committed: Awaited<ReturnType<typeof commitFormalAttempt>>;
  try {
    committed = await commitFormalAttempt(
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
        activationIntent:
          input.candidate_id === undefined
            ? undefined
            : { evaluation_id: input.candidate_id, ...input.expected_head },
        expectedHead: input.expected_head,
        capture: input.capture,
        modelAdmission: 'durable',
        judgeExecution: authority,
        requireUnassistedModelEvidence: input.require_unassisted_model_evidence,
        onActivated: async (tx, prepared) => {
          await writeResolution(tx, prepared, 'effective');
        },
      },
    );
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      !['cas_conflict', 'coordinate_mismatch'].includes(error.code)
    )
      throw error;
    const [current] = await db
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, input.evaluation_group_id));
    if (
      (current?.effective_evaluation_id ?? null) === input.expected_head.expected_effective_id &&
      (current?.generation ?? 0) === input.expected_head.expected_generation
    )
      throw error;
    return finishSuperseded();
  }
  // Held evaluation and recovery of an already-activated candidate skip the activation callback.
  await db.transaction((tx) => writeResolution(tx, committed, committed.status));
  return committed;
}
