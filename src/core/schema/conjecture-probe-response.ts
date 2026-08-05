import { z } from 'zod';

export const CONJECTURE_PROBE_RESPONSE_RULE_VERSION =
  'conjecture_probe_response_signature_v1' as const;

export const ConjectureProbeSignatureMatch = z
  .object({
    match: z.enum(['gold', 'target_error', 'neither', 'ambiguous']),
    explanation_md: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ConjectureProbeSignatureMatchT = z.infer<typeof ConjectureProbeSignatureMatch>;

export const ConjectureProbeResponseJudgement = z
  .object({
    rule_version: z.literal(CONJECTURE_PROBE_RESPONSE_RULE_VERSION),
    answer_result: z.enum(['correct', 'incorrect', 'ungradable']),
    target_error_match: z.enum(['matched', 'not_matched', 'ambiguous']),
    gradable: z.boolean(),
    reason_code: z.enum([
      'gold_signature_matched',
      'target_error_signature_matched',
      'response_matches_neither_signature',
      'correctness_signature_conflict',
      'correctness_judge_ungradable',
      'signature_match_ambiguous',
      'signature_judgement_missing',
    ]),
    signature_match_explanation_md: z.string().trim().min(1).max(2000).nullable(),
    evidence_refs: z
      .array(
        z.enum([
          'learner_response',
          'gold_response_signature',
          'target_error_response_signature',
          'correctness_judge',
        ]),
      )
      .min(1),
  })
  .strict();
export type ConjectureProbeResponseJudgementT = z.infer<typeof ConjectureProbeResponseJudgement>;

/**
 * Cross-reader/writer semantic matrix for a persisted probe disposition.
 * Shape validation alone is insufficient: a well-formed gold judgement cannot
 * support outcome=0, and a target-error judgement cannot support outcome=1.
 */
export function isCanonicalProbeOutcomeJudgement(input: {
  outcome: 0 | 1 | null;
  judgement: ConjectureProbeResponseJudgementT | null | undefined;
}): boolean {
  const judgement = input.judgement;
  if (!judgement || judgement.gradable !== true) return false;
  if (input.outcome === 1) {
    return (
      judgement.answer_result === 'correct' &&
      judgement.target_error_match === 'not_matched' &&
      judgement.reason_code === 'gold_signature_matched'
    );
  }
  if (input.outcome === 0) {
    return (
      judgement.answer_result === 'incorrect' &&
      judgement.target_error_match === 'matched' &&
      judgement.reason_code === 'target_error_signature_matched'
    );
  }
  return (
    judgement.answer_result === 'incorrect' &&
    judgement.target_error_match === 'not_matched' &&
    judgement.reason_code === 'response_matches_neither_signature'
  );
}

const ALL_RESPONSE_EVIDENCE_REFS = [
  'learner_response',
  'gold_response_signature',
  'target_error_response_signature',
  'correctness_judge',
] as const;

function ungradableJudgement(
  reasonCode:
    | 'correctness_signature_conflict'
    | 'correctness_judge_ungradable'
    | 'signature_match_ambiguous'
    | 'signature_judgement_missing',
  signatureMatchExplanationMd: string | null = null,
): ConjectureProbeResponseJudgementT {
  return {
    rule_version: CONJECTURE_PROBE_RESPONSE_RULE_VERSION,
    answer_result: 'ungradable',
    target_error_match: 'ambiguous',
    gradable: false,
    reason_code: reasonCode,
    signature_match_explanation_md: signatureMatchExplanationMd,
    evidence_refs: [...ALL_RESPONSE_EVIDENCE_REFS],
  };
}

/**
 * Reconcile the ordinary correctness verdict with the SAME judge call's
 * semantic comparison against the immutable gold and target-error signatures.
 * Missing, ambiguous, or contradictory evidence fails closed.
 */
export function classifyConjectureProbeResponseFromJudgeMatch(
  coarseOutcome: 'correct' | 'incorrect' | 'partial' | 'unsupported',
  signatureMatch: ConjectureProbeSignatureMatchT | undefined,
): ConjectureProbeResponseJudgementT {
  if (coarseOutcome === 'partial' || coarseOutcome === 'unsupported') {
    return ungradableJudgement('correctness_judge_ungradable');
  }
  if (!signatureMatch) {
    return ungradableJudgement('signature_judgement_missing');
  }
  if (signatureMatch.match === 'ambiguous') {
    return ungradableJudgement('signature_match_ambiguous', signatureMatch.explanation_md);
  }
  if (coarseOutcome === 'correct' && signatureMatch.match === 'gold') {
    return {
      rule_version: CONJECTURE_PROBE_RESPONSE_RULE_VERSION,
      answer_result: 'correct',
      target_error_match: 'not_matched',
      gradable: true,
      reason_code: 'gold_signature_matched',
      signature_match_explanation_md: signatureMatch.explanation_md,
      evidence_refs: [...ALL_RESPONSE_EVIDENCE_REFS],
    };
  }
  if (coarseOutcome === 'incorrect' && signatureMatch.match === 'target_error') {
    return {
      rule_version: CONJECTURE_PROBE_RESPONSE_RULE_VERSION,
      answer_result: 'incorrect',
      target_error_match: 'matched',
      gradable: true,
      reason_code: 'target_error_signature_matched',
      signature_match_explanation_md: signatureMatch.explanation_md,
      evidence_refs: [...ALL_RESPONSE_EVIDENCE_REFS],
    };
  }
  if (coarseOutcome === 'incorrect' && signatureMatch.match === 'neither') {
    return {
      rule_version: CONJECTURE_PROBE_RESPONSE_RULE_VERSION,
      answer_result: 'incorrect',
      target_error_match: 'not_matched',
      gradable: true,
      reason_code: 'response_matches_neither_signature',
      signature_match_explanation_md: signatureMatch.explanation_md,
      evidence_refs: [...ALL_RESPONSE_EVIDENCE_REFS],
    };
  }
  return ungradableJudgement('correctness_signature_conflict', signatureMatch.explanation_md);
}
