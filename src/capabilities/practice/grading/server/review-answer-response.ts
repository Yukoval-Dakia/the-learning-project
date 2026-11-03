import type { CreateAttemptBody } from '../../api/contracts';
import { ratingFromCoarseOutcome } from './judge-rating';
import { JUDGE_RUN_TABLE, judgeRunPollUrl } from './judge-run-status';
import type { ReviewAnswerResult } from './review-operation';

/** The 202 receipt of an original accepted onto the durable lane (createAttempt and advice). */
export function projectJudgeRunPending(runId: string) {
  return {
    run_id: runId,
    verdict: 'pending' as const,
    backfill: {
      channel: 'sse' as const,
      url: `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/events`,
      poll_url: judgeRunPollUrl(runId),
    },
  };
}

export type JudgeRunPending = ReturnType<typeof projectJudgeRunPending>;

/** The 202 receipt is told apart by its `verdict` value, never by which keys a body carries. */
export function isJudgeRunPending(body: object): body is JudgeRunPending {
  return (body as { verdict?: unknown }).verdict === 'pending';
}

/**
 * Explicit divert marker on the 202. A wrapper that keys on it (createAttemptResource) cannot
 * mistake an unrelated future 202 for a pending-judge body that has no `review_event`.
 */
export const DURABLE_DIVERT_HEADER = 'x-durable-divert';
export const DURABLE_DIVERT_JUDGE = 'judge';

/** Hono shape of the 202 receipt, shared by createAttempt and advice. */
export function durablePendingResponse(body: JudgeRunPending): Response {
  return Response.json(body, {
    status: 202,
    headers: { Location: body.backfill.url, [DURABLE_DIVERT_HEADER]: DURABLE_DIVERT_JUDGE },
  });
}

// Both transports expose the same accepted attempt and durable-pending JSON projection.
export function projectReviewAnswerResponse(body: CreateAttemptBody, result: ReviewAnswerResult) {
  if (result.kind === 'pending') {
    return { kind: 'pending' as const, body: projectJudgeRunPending(result.run_id) };
  }
  const committed = result.committed;
  const judged = committed.candidate.result;
  return {
    kind: 'committed' as const,
    body: {
      status: committed.status,
      assessment: {
        submission_id: committed.submission.submission_id,
        evaluation_group_id: committed.submission.evaluation_group_id,
        candidate_id: committed.candidate.evaluation.record.evaluation_id,
        activation_intent: committed.activation_intent,
        effect: committed.status === 'effective' ? committed.activation.effect : null,
      },
      review_event: { id: committed.attempt_id },
      judge: body.self_report
        ? null
        : {
            route: 'evaluate_submission',
            score: judged.score,
            coarse_outcome: judged.coarse_outcome,
            ...(judged.coarse_outcome === 'partial_unknown'
              ? { partial_units: judged.partial_units }
              : {}),
            confidence: judged.confidence,
            feedback_md: judged.feedback_md,
            evidence_json: judged.evidence_json,
            capability_ref: judged.capability_ref,
            suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
            auto_rated: body.auto_rate,
            judge_event_id: null,
          },
    },
  };
}
