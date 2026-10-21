import type { ProbeResolution } from '@/core/schema/conjecture';

export interface PriorProbeResult {
  probe_question_id: string;
  outcome: 0 | 1;
  resolution: ProbeResolution;
}

export function isEvidenceResult(result: PriorProbeResult): boolean {
  return (
    result.outcome === 0 &&
    (result.resolution === 'evidence_for' || result.resolution === 'confirmed')
  );
}

/**
 * Convert a grading outcome into a conjecture-survival decision.
 *
 * Prior `probe_result` history is immutable; this pure fold owns the evidence-strength
 * rule: a wrong answer is only preliminary until a distinct probe question for the same
 * conjecture has produced compatible evidence. A correct answer retires the conjecture.
 */
export function resolveProbeResolution(
  outcome: 0 | 1,
  currentProbeQuestionId: string,
  priorResults: readonly PriorProbeResult[],
): ProbeResolution {
  if (outcome === 1) return 'retired';
  const hasIndependentPrior = priorResults.some(
    (result) => result.probe_question_id !== currentProbeQuestionId && isEvidenceResult(result),
  );
  return hasIndependentPrior ? 'confirmed' : 'evidence_for';
}
