import type { ProbeResolution } from '@/core/schema/conjecture';

export interface PriorProbeResult {
  probe_question_id: string;
  outcome: 0 | 1;
  resolution: ProbeResolution;
}

/**
 * Convert a grading outcome into a conjecture-survival decision.
 *
 * Persistence supplies the immutable prior `probe_result` history; this pure fold
 * alone owns the evidence-strength rule. A wrong answer is only preliminary until
 * a distinct probe question for the same conjecture has already produced
 * compatible evidence. A correct answer keeps the established retirement
 * behaviour.
 */
export function resolveProbeResolution(
  outcome: 0 | 1,
  currentProbeQuestionId: string,
  priorResults: readonly PriorProbeResult[],
): ProbeResolution {
  if (outcome === 1) return 'retired';
  const hasIndependentPrior = priorResults.some(
    (result) =>
      result.probe_question_id !== currentProbeQuestionId &&
      result.outcome === 0 &&
      (result.resolution === 'evidence_for' || result.resolution === 'confirmed'),
  );
  return hasIndependentPrior ? 'confirmed' : 'evidence_for';
}
