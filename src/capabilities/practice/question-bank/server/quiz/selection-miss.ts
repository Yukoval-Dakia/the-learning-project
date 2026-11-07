import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events/index';

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
  // Eligible items existed but could not meet demand: some were used and a residual
  // gap remains. Distinct from NO_ALLOWED_USE_ITEM, which means the pool was truly empty.
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

/** Observe-only ledger write. It never dispatches supply work or participates in selection. */
export async function writeSelectionMissEvent(db: Db, miss: SelectionMissV1): Promise<string> {
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
