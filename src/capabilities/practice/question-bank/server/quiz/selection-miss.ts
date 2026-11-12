import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import { DEFAULT_EVIDENCE_DEADLINE_DAYS } from '@/kernel/supply-contracts';

type DbLike = Db | Tx;

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

/** Ledger write. Supply reads these rows as selection_miss demands; this write does not dispatch. */
export async function writeSelectionMissEvent(db: DbLike, miss: SelectionMissV1): Promise<string> {
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

export interface SelectionMissDemand {
  eventId: string;
  recordedAt: Date;
  miss: SelectionMissV1;
}

/** Latest selection_miss per knowledge inside the supply evidence window. A bad payload is skipped. */
export async function readOpenSelectionMissDemands(
  db: DbLike,
  now: Date,
): Promise<SelectionMissDemand[]> {
  const since = new Date(now.getTime() - DEFAULT_EVIDENCE_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: event.id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(eq(event.action, 'experimental:selection_miss'), gte(event.created_at, since)))
    .orderBy(desc(event.created_at), desc(event.id));
  const seen = new Set<string>();
  const demands: SelectionMissDemand[] = [];
  for (const row of rows) {
    let miss: SelectionMissV1;
    try {
      miss = parseSelectionMiss(row.payload);
    } catch {
      continue;
    }
    if (seen.has(miss.knowledge_id)) continue;
    seen.add(miss.knowledge_id);
    demands.push({ eventId: row.id, recordedAt: row.created_at, miss });
  }
  return demands;
}
