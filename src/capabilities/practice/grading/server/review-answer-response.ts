import type { CreateAttemptBody } from '../../api/contracts';
import { ratingFromCoarseOutcome } from './judge-rating';
import { JUDGE_RUN_TABLE, judgeRunPollUrl } from './judge-run-status';
import type { ReviewAnswerResult } from './review-operation';

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

// Both transports expose the same accepted attempt and durable-pending JSON projection.
export function projectReviewAnswerResponse(body: CreateAttemptBody, result: ReviewAnswerResult) {
  if (result.kind === 'pending') {
    return {
      kind: 'pending' as const,
      body: projectJudgeRunPending(result.run_id),
    };
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
            ...(judged.grading_provenance ? { grading_provenance: judged.grading_provenance } : {}),
            suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
            auto_rated: body.auto_rate,
            judge_event_id: null,
          },
    },
  };
}
