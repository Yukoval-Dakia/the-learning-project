// Gap target derivation shared by every ticket seam (bank-gap tool, manual operator entry).
// It is value-only: no DB, boss or capability runtime imports, so a dry run can print the
// target without DATABASE_URL. Callers pass the demand already narrowed to any signed scope.
import {
  EvidenceDemandV1,
  type EvidenceDemandV1T,
  evidenceDemandToTargetContext,
} from '@/kernel/supply-contracts';
import type { DifficultyBand, QuestionSupplyTarget } from './target-discovery';
import { targetFingerprint } from './target-fingerprint';

/**
 * Derive the preparer's supply target from a demand. The bank-gap tool narrows the demand to
 * its signed search scope first and then calls this same function, so an identical gap yields
 * the identical fingerprint (the 7-day cooldown key) regardless of which seam filed it.
 */
export function buildQuestionPreparerTarget(
  demand: EvidenceDemandV1T,
  options: {
    /** Count requested by a filing scope; raises the inventory goal exactly like the bank-gap path. */
    requestedCount?: number;
    /** True when the filing scope pinned the kind (bank-gap signed search) — a hard constraint. */
    kindRequired?: boolean;
    /** Why this gap exists; persisted on the target and in the dispatch ledger. */
    reason: string;
  },
): QuestionSupplyTarget {
  const parsed = EvidenceDemandV1.parse(demand);
  const [firstKind] = parsed.task.kinds;
  const kind = parsed.task.kinds.length === 1 && firstKind !== undefined ? firstKind : 'any';
  // One KC set for both seams: the bank-gap caller already replaced the claim with its signed
  // scope, so deduping here is the same value it used to compute locally.
  const knowledgeIds = [...new Set(parsed.claim.knowledge_ids)];
  // eligible_count is the inventory goal; requestedCount is a filing's expected batch. Take
  // the larger and clamp to [1,10] (the executor/quiz_gen payload count cap).
  const desiredCount = Math.min(
    10,
    Math.max(1, parsed.inventory_goal.eligible_count, options.requestedCount ?? 0),
  );
  return {
    // The id names the gap, not the filing seam; keeping one shape means an identical demand
    // is the same target (and the same ledger subject) no matter where it came from.
    id: `bankgap:${parsed.demand_id}`,
    fingerprint: targetFingerprint({
      subjectId: parsed.subject_id,
      knowledgeIds,
      kind,
      difficultyBand: parsed.difficulty.band as DifficultyBand,
      gapKind: 'frontier_zero',
      minSourceTier: 2,
    }),
    gapKind: 'frontier_zero',
    subjectId: parsed.subject_id,
    knowledgeIds,
    kind,
    difficultyBand: parsed.difficulty.band as DifficultyBand,
    desiredCount,
    // A gap means existing questions did not cover the demand: prefer finding an existing
    // question on the web (tier 2), then closed-book generation.
    minSourceTier: 2,
    routePreference: ['sourcing_web', 'quiz_gen'],
    priority: 50,
    reason: options.reason,
    constraints: options.kindRequired === true ? { kindRequired: true } : {},
    context: evidenceDemandToTargetContext(parsed),
  };
}
