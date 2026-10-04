import { eq, sql } from 'drizzle-orm';
import {
  type ActivateEvaluationIntentT,
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
import { submissionWasAssisted } from './assistance';
import { type SaveSubmissionRequest, saveSubmission } from './submit';

/** Formal entry input already carries the issuance served to the learner. */
export async function previewFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  signal?: AbortSignal,
  options: { selfReport?: boolean; candidateId?: string; expectedSubmissionIds?: string[] } = {},
) {
  const [issuance] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, request.issuance_id))
    .limit(1);
  if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
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
  const candidate = await evaluateAttempt({
    db: database,
    entry,
    contract: {
      submission_id: saved.submission.submission_id,
      evaluation_group_id: saved.submission.evaluation_group_id,
      evaluation_key: `${options.selfReport ? 'self-report' : 'submission'}:${saved.submission.submission_id}`,
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
            model_executor: createFormalModelExecutor(database, signal),
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
    .where(eq(evaluation_effective_head.evaluation_group_id, saved.submission.evaluation_group_id))
    .limit(1);
  return {
    candidate,
    submission: saved.submission,
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

export interface FormalAttemptCapture {
  session_id?: string | null;
  stream_item_id?: string | null;
  response_md?: string | null;
  reasoning_trace?: string | null;
  self_confidence?: number | null;
  latency_ms?: number | null;
  hints_used?: number;
  final_hint_level?: number;
}

/** The response and candidate are immutable; the activation is the only learning writer. */
export async function commitFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  options: {
    activationIntent?: ActivateEvaluationIntentT;
    selfReport?: boolean;
    userRating?: 'again' | 'hard' | 'good';
    capture?: FormalAttemptCapture;
    signal?: AbortSignal;
    requireUnassistedModelEvidence?: boolean;
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
        original_evaluation_id: candidate.evaluation.record.evaluation_id,
        entry,
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
      }),
      user_rating: options.userRating,
    },
    {
      actorRef: `assessment:${entry}`,
      record: async (tx) => {
        await record(tx);
        await options.onActivated?.(tx, prepared, attemptId);
      },
    },
  );
  if (activation.status !== 'activated' && activation.status !== 'already_effective') {
    throw new ApiError(activation.status, 'candidate could not become effective', 409);
  }
  return { status: 'effective' as const, attempt_id: attemptId, activation, ...prepared };
}
