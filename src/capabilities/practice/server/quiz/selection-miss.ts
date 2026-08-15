import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { z } from 'zod';

export const SELECTION_MISS_VERSION = 1 as const;
export const DEFAULT_SELECTION_POLICY_VERSION = 'matcher-v1';

export const SELECTION_MISS_REASONS = [
  'NO_ALLOWED_USE_ITEM',
  'NO_NEAR_DIFFICULTY',
  'ONLY_EXPOSED_FAMILIES',
  'NO_REQUIRED_KIND',
  'NO_TRUSTED_SOURCE',
  'NO_ACCESSIBLE_ITEM',
  'NO_SCORABLE_ITEM',
  'NO_INDEPENDENT_FAMILY',
  'ONLY_QUARANTINED_ITEMS',
  // Eligible items existed but were insufficient to satisfy demand (partial fulfill: some used,
  // residual gap). Kept distinct from NO_ALLOWED_USE_ITEM, which means the pool was truly empty.
  'INSUFFICIENT_ELIGIBLE_ITEMS',
] as const;

export const selectionMissReasonSchema = z.enum(SELECTION_MISS_REASONS);

const nullableCount = z.number().int().nonnegative().nullable();

export const evaluatedSelectionConstraintsSchema = z.object({
  live_knowledge: z.boolean(),
  candidate_count: z.number().int().nonnegative(),
  near_difficulty_count: z.number().int().nonnegative(),
  required_kind_count: z.number().int().nonnegative(),
  trusted_source_count: z.number().int().nonnegative(),
  accessible_count: z.number().int().nonnegative(),
  scorable_count: z.number().int().nonnegative(),
  independent_family_count: nullableCount,
  exposed_family_count: nullableCount,
  quarantined_count: z.number().int().nonnegative(),
});

export type EvaluatedSelectionConstraints = z.infer<typeof evaluatedSelectionConstraintsSchema>;

export const selectionMissSchema = z.object({
  version: z.literal(SELECTION_MISS_VERSION),
  reason: selectionMissReasonSchema,
  subject_id: z.string().min(1),
  knowledge_id: z.string().min(1),
  selection_policy_version: z.string().min(1),
  evaluated_constraints: evaluatedSelectionConstraintsSchema,
});

export type SelectionMissV1 = z.infer<typeof selectionMissSchema>;

export function parseSelectionMiss(value: unknown): SelectionMissV1 {
  return selectionMissSchema.parse(value);
}

function reasonFor(c: EvaluatedSelectionConstraints): SelectionMissV1['reason'] {
  // A non-live (archived/missing) KC collapses into NO_ACCESSIBLE_ITEM: the reason vocabulary
  // has no dedicated NO_LIVE_KNOWLEDGE axis, and a dead KC yields zero accessible items by
  // definition. This is a deliberate conflation of the lifecycle axis with the availability
  // axis — a dashboard filtering on NO_ACCESSIBLE_ITEM mixes archived-KC and item-scarcity misses.
  if (!c.live_knowledge) return 'NO_ACCESSIBLE_ITEM';
  if (c.candidate_count === 0) return 'NO_ALLOWED_USE_ITEM';
  if (c.near_difficulty_count === 0) return 'NO_NEAR_DIFFICULTY';
  if (c.required_kind_count === 0) return 'NO_REQUIRED_KIND';
  if (c.trusted_source_count === 0) return 'NO_TRUSTED_SOURCE';
  if (c.accessible_count === 0 && c.quarantined_count > 0) {
    return 'ONLY_QUARANTINED_ITEMS';
  }
  if (c.accessible_count === 0) return 'NO_ACCESSIBLE_ITEM';
  if (c.scorable_count === 0) return 'NO_SCORABLE_ITEM';
  if (c.independent_family_count === 0) return 'NO_INDEPENDENT_FAMILY';
  if (
    c.independent_family_count != null &&
    c.exposed_family_count != null &&
    c.independent_family_count === c.exposed_family_count
  ) {
    return 'ONLY_EXPOSED_FAMILIES';
  }
  // Phase A has no allowed-use projection yet. Reaching here means every observable constraint
  // passed but selection still missed — the matcher's partial-fulfill path (some eligible items
  // used, a residual gap remains). accessible_count > 0 is guaranteed at this point (the
  // accessible_count === 0 branch returned above), so eligible items demonstrably existed:
  // classify as INSUFFICIENT_ELIGIBLE_ITEMS rather than overloading NO_ALLOWED_USE_ITEM, which
  // represents the genuine candidate_count === 0 truly-empty pool. The NO_ALLOWED_USE_ITEM arm is a
  // defensive fallback should the guards above ever be reordered.
  return c.accessible_count > 0 ? 'INSUFFICIENT_ELIGIBLE_ITEMS' : 'NO_ALLOWED_USE_ITEM';
}

export function classifySelectionMiss(
  envelope: Pick<SelectionMissV1, 'subject_id' | 'knowledge_id' | 'selection_policy_version'>,
  constraints: EvaluatedSelectionConstraints,
): SelectionMissV1 {
  const evaluated = evaluatedSelectionConstraintsSchema.parse(constraints);
  return selectionMissSchema.parse({
    version: SELECTION_MISS_VERSION,
    reason: reasonFor(evaluated),
    ...envelope,
    evaluated_constraints: evaluated,
  });
}

/** Observe-only ledger write. It never dispatches supply work or participates in selection. */
export async function writeSelectionMissEvent(db: Db, miss: SelectionMissV1): Promise<string> {
  // `miss` is already SelectionMissV1-validated by the only caller (classifySelectionMiss ends in
  // selectionMissSchema.parse); trust the type and write directly instead of re-parsing.
  return writeEvent(db, {
    id: newId(),
    actor_kind: 'system',
    actor_ref: 'quiz_matcher',
    action: 'experimental:selection_miss',
    subject_kind: 'knowledge',
    subject_id: miss.knowledge_id,
    outcome: null,
    payload: miss,
    ingest_at: new Date(),
  });
}
