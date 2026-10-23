import type { CreateAttemptBody } from '../api/contracts';
import { ratingFromCoarseOutcome } from './judge-rating';
import { JUDGE_RUN_TABLE } from './judge-run-status';
import type { ReviewAnswerResult } from './review-operation';

// Both transports expose the same accepted attempt and durable-pending JSON projection.
export function projectReviewAnswerResponse(body: CreateAttemptBody, result: ReviewAnswerResult) {
  if (result.kind === 'pending') {
    const eventsUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(result.run_id)}/events`;
    const pollUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(result.run_id)}/status`;
    return {
      kind: 'pending' as const,
      body: {
        run_id: result.run_id,
        verdict: 'pending' as const,
        backfill: { channel: 'sse' as const, url: eventsUrl, poll_url: pollUrl },
      },
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
            suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
            auto_rated: body.auto_rate,
            judge_event_id: null,
          },
    },
  };
}
