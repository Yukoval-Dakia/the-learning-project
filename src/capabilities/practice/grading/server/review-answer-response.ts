import type { z } from 'zod';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FsrsRating } from '@/kernel/capability-contract-schemas';
import type { FormalAttemptPreview } from '@/kernel/judge';
import type { CreateAttemptBody } from '../../api/contracts';
import type { NormalizedReviewSubmitActivityRef } from './activity-ref';
import type { AssistanceReceipt } from './assessment/assistance';
import type { SealedSelfClaim } from './assessment/self-claim';
import { ratingFromCoarseOutcome } from './judge-rating';
import { JUDGE_RUN_TABLE, judgeRunPollUrl } from './judge-run-status';
import type { ReviewAnswerResult } from './review-operation';

type AttemptVerdictOutcome =
  | 'correct'
  | 'partial'
  | 'incorrect'
  | 'unsupported'
  | 'partial_unknown';

/**
 * The learner's rating operation, normalized for the response: under auto_rate
 * the rating field is the judge's suggestion, never the learner's words. Only a
 * self-report or a manually chosen rating counts as a claim.
 */
function echoAttemptClaim(body: {
  self_report?: boolean;
  auto_rate?: boolean;
  rating?: z.infer<typeof FsrsRating> | null;
  self_confidence?: number | null;
}) {
  return body.self_report || !body.auto_rate
    ? { rating: body.rating ?? null, confidence: body.self_confidence ?? null }
    : { rating: null, confidence: body.self_confidence ?? null };
}

// Evidence split: exposure (sealed receipt), judged outcome, and the learner's
// own claim stay separate — a correct or confident assisted answer is still
// not independent. Every attempt surface (sync response, advice preview,
// durable terminal result) projects through this one shape.
export function projectAttemptEvidence(input: {
  assistance: AssistanceReceipt | null;
  verdict: { outcome: AttemptVerdictOutcome; score: number | null } | null;
  self_claim: SealedSelfClaim | null;
}) {
  return {
    assistance: input.assistance
      ? {
          status: input.assistance.status,
          max_dose: input.assistance.max_dose,
          kinds: input.assistance.kinds,
          phase: input.assistance.phase,
        }
      : null,
    verdict: input.verdict,
    self_claim: input.self_claim,
  };
}

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

export type ReviewAnswerJudge = JudgeResultV2T & {
  route: 'evaluate_submission';
  suggested_rating: z.infer<typeof FsrsRating> | null;
};

export interface ReviewAnswerAdviceState {
  activity_ref: NormalizedReviewSubmitActivityRef['activity_ref'];
  question_id: string;
  knowledge_ids: string[];
  submission_id: string;
  evaluation_group_id: string;
  candidate_id: string;
  activation_intent: FormalAttemptPreview['activation_intent'];
  automatic_commit: boolean;
  judge: ReviewAnswerJudge;
  evidence: ReturnType<typeof projectAttemptEvidence>;
}

function projectReviewAnswerJudge(judged: JudgeResultV2T) {
  return {
    route: 'evaluate_submission',
    score: judged.score,
    coarse_outcome: judged.coarse_outcome,
    ...(judged.coarse_outcome === 'partial_unknown' ? { partial_units: judged.partial_units } : {}),
    confidence: judged.confidence,
    feedback_md: judged.feedback_md,
    evidence_json: judged.evidence_json,
    capability_ref: judged.capability_ref,
    ...(judged.grading_provenance ? { grading_provenance: judged.grading_provenance } : {}),
    suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
  };
}

export function projectReviewAdviceJudge(judged: JudgeResultV2T): ReviewAnswerJudge {
  return {
    route: 'evaluate_submission',
    score: judged.score,
    score_meaning: judged.score_meaning,
    coarse_outcome: judged.coarse_outcome,
    ...(judged.coarse_outcome === 'partial_unknown' ? { partial_units: judged.partial_units } : {}),
    confidence: judged.confidence,
    feedback_md: judged.feedback_md,
    evidence_json: judged.evidence_json,
    capability_ref: judged.capability_ref,
    ...(judged.grading_provenance ? { grading_provenance: judged.grading_provenance } : {}),
    suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
  } as ReviewAnswerJudge;
}

export function projectReviewAnswerAdviceState(input: {
  identity: NormalizedReviewSubmitActivityRef;
  knowledgeIds: readonly string[];
  prepared: FormalAttemptPreview;
}): ReviewAnswerAdviceState {
  const judged = input.prepared.candidate.result;
  return {
    activity_ref: input.identity.activity_ref,
    question_id: input.identity.question_id,
    knowledge_ids: [...input.knowledgeIds],
    submission_id: input.prepared.submission.submission_id,
    evaluation_group_id: input.prepared.submission.evaluation_group_id,
    candidate_id: input.prepared.candidate.evaluation.record.evaluation_id,
    activation_intent: input.prepared.activation_intent,
    automatic_commit: input.prepared.automatic_commit,
    judge: projectReviewAdviceJudge(judged),
    evidence: projectAttemptEvidence({
      assistance: input.prepared.assistance,
      verdict: { outcome: judged.coarse_outcome, score: judged.score },
      self_claim: null,
    }),
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
      attempt_event_id: committed.attempt_id,
      assessment: {
        submission_id: committed.submission.submission_id,
        evaluation_group_id: committed.submission.evaluation_group_id,
        candidate_id: committed.candidate.evaluation.record.evaluation_id,
        activation_intent: committed.activation_intent,
        effect: committed.status === 'effective' ? committed.activation.effect : null,
      },
      review_event: { id: committed.attempt_id },
      // self_claim follows the rating operation, not the submission replay
      // flag: a submission can be persisted before the learner ever rates
      // (advice preview, durable probe), so a replayed submission may still be
      // the first rating operation — its sealed values read back identical.
      // When the rating operation itself was already performed, the sealed
      // activation receipt and attempt capture answer — never this request's
      // unsealed input.
      evidence: projectAttemptEvidence({
        assistance: committed.assistance,
        verdict: body.self_report ? null : { outcome: judged.coarse_outcome, score: judged.score },
        self_claim: committed.replayed
          ? (result.sealed_claim ?? { rating: null, confidence: null })
          : echoAttemptClaim(body),
      }),
      judge: body.self_report
        ? null
        : { ...projectReviewAnswerJudge(judged), auto_rated: body.auto_rate, judge_event_id: null },
    },
  };
}
