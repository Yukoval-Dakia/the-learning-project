import type { InterventionAuthoringContextT } from '@/core/schema/intervention';
import { normalizePrompt } from '@/kernel/prompt-identity';
import type { LearnerEvidenceLoad } from '@/kernel/read-models/learner-evidence';

/** Same prompt identity the question preparer uses when it refuses a reused miss. */
export function transferRepeatsMissedQuestion(
  transferPrompt: string,
  missedPrompts: readonly string[],
): boolean {
  const candidate = normalizePrompt(transferPrompt);
  return missedPrompts.some((prompt) => normalizePrompt(prompt) === candidate);
}

/** Task input for the package author. Evidence blocks are resolved outside the snapshot. */
export function interventionAuthorTaskInput(
  context: InterventionAuthoringContextT,
  evidence: Pick<LearnerEvidenceLoad, 'blocks' | 'unresolved_ref_count' | 'omitted_ref_count'>,
) {
  return {
    snapshot: context.snapshot,
    recommendation: context.recommendation,
    learner_evidence: {
      blocks: evidence.blocks,
      unresolved_ref_count: evidence.unresolved_ref_count,
      omitted_ref_count: evidence.omitted_ref_count,
    },
    output_contract: {
      material_count: 1,
      diagnostic_kinds: ['immediate', 'delayed', 'transfer'] as const,
      tested_claim_md: context.snapshot.conjecture.claim_md,
      target_error_rule_md: context.snapshot.conjecture.target_error_rule_md,
    },
  };
}
