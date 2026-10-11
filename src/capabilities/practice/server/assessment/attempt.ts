import { eq, sql } from 'drizzle-orm';
import {
  type ActivateEvaluationIntentT,
  type AssessmentAttemptCaptureT,
  type SubmissionRecordT,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  evaluation_effective_head,
  event,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  EvaluateSubmissionError,
  activateSubmissionCandidate,
  createFormalModelExecutor,
} from '../judge/evaluate-submission';
import { type GradingEntryPoint, evaluateAttempt } from '../judge/evaluation-authority';
import { type JudgeExecution, requireJudgeRunOpen } from '../judge-operational';
import { emitMasteryProgressSignal } from '../mastery-progress-signal';
import { submissionWasAssisted } from './assistance';
import { type SaveSubmissionRequest, saveSubmission } from './submit';

/** Persist the served original before a synchronous evaluation or durable dispatch. */
export async function prepareFormalAttemptSubmission(
  database: Db | Tx,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
) {
  const [issuance] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, request.issuance_id))
    .limit(1);
  if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
  if (
    issuance.container_occurrence_ref?.startsWith('ingestion:') &&
    entry !== 'ingestion_grading'
  ) {
    throw new ApiError('capture_entry_required', 'captured original belongs to ingestion', 409);
  }
  if (issuance.container_occurrence_ref?.startsWith('probe:') && entry !== 'conjecture_probe') {
    throw new ApiError(
      'probe_entry_required',
      'probe original belongs to its conjecture result writer',
      409,
    );
  }
  if (issuance.container_occurrence_ref?.startsWith('paper_') && entry !== 'paper_submit') {
    throw new ApiError(
      'paper_entry_required',
      'paper issuance must use its bound submission entry',
      409,
    );
  }
  const [revision] = await database
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (!revision || (revision.group_id !== questionId && !issuance.part_ids.includes(questionId))) {
    throw new ApiError('coordinate_mismatch', 'question is outside the frozen issuance', 409);
  }
  const scopedBasis = projectIssuedScoringBasis(revision, issuance.part_ids);
  const scopedUnitIds = new Set(scopedBasis.units.map((unit) => unit.scoring_unit_id));
  const saved = await saveSubmission(database, { ...request, actorRef: `assessment:${entry}` });
  if (!('submission' in saved)) {
    throw new ApiError(
      saved.status,
      saved.conflict_reason ?? saved.issues?.join('; ') ?? 'submission not accepted',
      409,
    );
  }
  const assisted = await submissionWasAssisted(database, saved.submission.submission_id);
  return { issuance, revision, scopedBasis, scopedUnitIds, submission: saved.submission, assisted };
}

/** Formal entry input already carries the issuance served to the learner. */
export async function previewFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  signal?: AbortSignal,
  options: {
    selfReport?: boolean;
    candidateId?: string;
    expectedSubmissionIds?: string[];
    modelAdmission?: 'durable';
    judgeExecution?: JudgeExecution;
  } = {},
) {
  const { issuance, revision, scopedBasis, scopedUnitIds, submission, assisted } =
    await prepareFormalAttemptSubmission(database, entry, questionId, request);
  const candidate = await evaluateAttempt({
    db: database,
    entry,
    contract: {
      judge_execution: options.judgeExecution,
      submission_id: submission.submission_id,
      evaluation_group_id: submission.evaluation_group_id,
      evaluation_key: `${options.selfReport ? 'self-report' : 'submission'}:${submission.submission_id}`,
      expected_evaluation_id: options.candidateId,
      expected_submission_ids: options.expectedSubmissionIds,
      ...(options.selfReport
        ? {
            mode: 'manual_assert' as const,
            provenance: { source: 'self_report' as const, assisted },
            asserted_unit_results: scopedBasis.units.map((unit) => ({
              status: 'pending' as const,
              scoring_unit_id: unit.scoring_unit_id,
              pending: {
                reason: 'unjudgeable' as const,
                detail: 'Explicit self-report schedules practice; no score was asserted.',
              },
            })),
          }
        : {
            provenance: { source: 'automatic' as const, assisted },
            model_executor: createFormalModelExecutor(
              database,
              signal,
              options.modelAdmission,
              options.judgeExecution,
            ),
          }),
    },
  }).catch((error: unknown) => {
    if (error instanceof EvaluateSubmissionError) {
      throw new ApiError(
        error.code,
        error.message,
        error.code === 'invalid_executor_spec' ? 422 : 409,
      );
    }
    throw error;
  });
  const [head] = await database
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, submission.evaluation_group_id))
    .limit(1);
  return {
    issuance,
    revision,
    candidate,
    submission: submission,
    automatic_commit:
      !options.selfReport &&
      !assisted &&
      candidate.result.coarse_outcome !== 'unsupported' &&
      revision.execution_plan.assignments
        .filter((assignment) =>
          assignment.scoring_unit_ids.some((unitId) => scopedUnitIds.has(unitId)),
        )
        .every((assignment) => assignment.executor.kind === 'deterministic'),
    activation_intent: {
      evaluation_id: candidate.evaluation.record.evaluation_id,
      expected_effective_id: head?.effective_evaluation_id ?? null,
      expected_generation: head?.generation ?? 0,
    },
  };
}

export type FormalAttemptCapture = AssessmentAttemptCaptureT;

/** One immutable participation anchor, including while a durable run is queued. */
export async function recordFormalAttemptCapture(
  tx: Tx,
  entry: GradingEntryPoint,
  questionId: string,
  submission: SubmissionRecordT,
  candidateId: string | null,
  capture: FormalAttemptCapture = {},
) {
  const attemptId = `evt_assessment_${submission.submission_id}`;
  // Pending receipts and retries share the same occurrence anchor. Capture is
  // first-write-wins; a retry's wall-clock latency cannot rewrite the attempt.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${attemptId}))`);
  const [existing] = await tx.select({ id: event.id }).from(event).where(eq(event.id, attemptId));
  if (existing) return;
  await writeEvent(tx, {
    id: attemptId,
    session_id: capture.session_id ?? null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:assessment_attempt',
    subject_kind: 'question',
    subject_id: questionId,
    // This event records participation. The group's effective evaluation owns
    // its verdict; self-report and a pending evaluation have no right/wrong bit.
    outcome: null,
    payload: {
      version: 1,
      submission_id: submission.submission_id,
      evaluation_group_id: submission.evaluation_group_id,
      issuance_id: submission.issuance_id,
      revision_id: submission.revision_id,
      original_evaluation_id: candidateId,
      entry,
      ...(entry === 'ingestion_grading' && capture.ingestion
        ? { ingestion: capture.ingestion, generated_by: capture.ingestion.generated_by }
        : {}),
      ...(capture.paper_artifact_id ? { paper_artifact_id: capture.paper_artifact_id } : {}),
      ...(capture.paper_started_at ? { paper_started_at: capture.paper_started_at } : {}),
      ...(capture.paper_feedback_policy
        ? { paper_feedback_policy: capture.paper_feedback_policy }
        : {}),
      ...(capture.part_ref !== undefined ? { part_ref: capture.part_ref } : {}),
      response_md: capture.response_md ?? null,
      ...(capture.stream_item_id ? { stream_item_id: capture.stream_item_id } : {}),
      ...(capture.reasoning_trace?.trim() ? { reasoning_trace: capture.reasoning_trace } : {}),
      ...(capture.self_confidence != null ? { self_confidence: capture.self_confidence } : {}),
      ...(capture.latency_ms != null ? { duration_ms: capture.latency_ms } : {}),
      ...(capture.hints_used !== undefined ? { hints_used: capture.hints_used } : {}),
      ...(capture.final_hint_level !== undefined
        ? { final_hint_level: capture.final_hint_level }
        : {}),
    },
    created_at: new Date(submission.submitted_at),
  });
}

/** The response and candidate are immutable; the activation is the only learning writer. */
export async function commitFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  options: {
    activationIntent?: ActivateEvaluationIntentT;
    expectedHead?: Pick<ActivateEvaluationIntentT, 'expected_effective_id' | 'expected_generation'>;
    selfReport?: boolean;
    modelAdmission?: 'durable';
    judgeExecution?: JudgeExecution;
    userRating?: 'again' | 'hard' | 'good';
    capture?: FormalAttemptCapture;
    signal?: AbortSignal;
    requireUnassistedModelEvidence?: boolean;
    beforeActivate?: (tx: Tx) => Promise<void>;
    onActivated?: (
      tx: Tx,
      prepared: Awaited<ReturnType<typeof previewFormalAttempt>>,
      attemptId: string,
    ) => Promise<void>;
  } = {},
) {
  if (options.selfReport && !options.userRating) {
    throw new ApiError('rating_required', 'self-report requires an explicit rating', 400);
  }
  const prepared = await previewFormalAttempt(
    database,
    entry,
    questionId,
    request,
    options.signal,
    {
      selfReport: options.selfReport,
      modelAdmission: options.modelAdmission,
      judgeExecution: options.judgeExecution,
      candidateId: options.activationIntent?.evaluation_id,
    },
  );
  const { candidate, submission } = prepared;
  if (
    options.requireUnassistedModelEvidence &&
    (options.selfReport ||
      candidate.evaluation.record.status !== 'completed' ||
      candidate.evaluation.record.provenance?.assisted !== false ||
      candidate.evaluation.record.run_refs.length === 0)
  ) {
    throw new ApiError(
      'unsupported_judge_route',
      'diagnostic requires an independent model evaluation',
      422,
    );
  }
  const attemptId = `evt_assessment_${submission.submission_id}`;
  const capture = options.capture ?? {};
  const record = async (tx: Tx) => {
    if (options.judgeExecution) await requireJudgeRunOpen(tx, options.judgeExecution);
    return recordFormalAttemptCapture(
      tx,
      entry,
      questionId,
      submission,
      candidate.evaluation.record.evaluation_id,
      capture,
    );
  };
  if (
    candidate.evaluation.record.status !== 'completed' ||
    (!options.selfReport && candidate.result.coarse_outcome === 'unsupported')
  ) {
    await database.transaction(record);
    return { status: 'review_required' as const, attempt_id: attemptId, ...prepared };
  }
  const activation = await activateSubmissionCandidate(
    database,
    {
      ...(options.activationIntent ?? {
        evaluation_id: candidate.evaluation.record.evaluation_id,
        expected_effective_id: null,
        expected_generation: 0,
        ...options.expectedHead,
      }),
      user_rating: options.userRating,
    },
    {
      actorRef: `assessment:${entry}`,
      judgeExecution: options.judgeExecution,
      beforeActivate: options.beforeActivate,
      allowCapturedOriginal: entry === 'ingestion_grading' && options.onActivated !== undefined,
      onThetaApplied: async (tx, observation) => {
        if (observation.outcome !== 1) return;
        // Isolate optional telemetry failures without poisoning the activation.
        try {
          await tx.transaction(async (sp) => {
            await emitMasteryProgressSignal({
              db: sp,
              knowledgeIds: observation.knowledgeIds,
              questionId,
              attemptEventId: attemptId,
              sourceArtifactId: capture.paper_artifact_id ?? null,
              now: new Date(submission.submitted_at),
            });
          });
        } catch (error) {
          console.warn('[assessment] mastery progress signal failed (non-fatal):', error);
        }
      },
      recordOriginal: record,
      record: async (tx) => {
        await options.onActivated?.(tx, prepared, attemptId);
      },
    },
  );
  if (activation.status !== 'activated' && activation.status !== 'already_effective') {
    throw new ApiError(activation.status, 'candidate could not become effective', 409);
  }
  return { status: 'effective' as const, attempt_id: attemptId, activation, ...prepared };
}
