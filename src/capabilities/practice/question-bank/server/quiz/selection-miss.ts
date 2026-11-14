import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import { readServablePoolMembership } from '@/kernel/read-models/servable-pool-membership';
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

// Reasons whose recorded demand is only "the pool had no servable item". For
// these, one canonically servable member fulfils the recorded gap. Constrained
// axes (kind/difficulty/source/family/scorability/quarantine) and
// INSUFFICIENT_ELIGIBLE_ITEMS can't be re-evaluated from `any member exists`
// alone, so they stay open until a reason-aware projection exists — fail closed.
const UNCONSTRAINED_EMPTY_REASONS = new Set<SelectionMissV1['reason']>([
  'NO_ALLOWED_USE_ITEM',
  'NO_ACCESSIBLE_ITEM',
  'NO_INDEPENDENT_FAMILY',
]);

// The recorded constraint set only has to be self-consistent for an
// absolute-empty miss: every evaluated count is 0. A row that fails this check
// is ambiguous — retain it rather than guess it was empty.
function isConsistentAbsoluteEmpty(miss: SelectionMissV1): boolean {
  if (miss.selection_policy_version !== DEFAULT_SELECTION_POLICY_VERSION) return false;
  if (!UNCONSTRAINED_EMPTY_REASONS.has(miss.reason)) return false;
  const constraints = miss.evaluated_constraints;
  return (
    constraints.candidate_count === 0 &&
    constraints.near_difficulty_count === 0 &&
    constraints.required_kind_count === 0 &&
    constraints.trusted_source_count === 0 &&
    constraints.accessible_count === 0 &&
    constraints.scorable_count === 0 &&
    (constraints.independent_family_count === 0 || constraints.independent_family_count === null) &&
    (constraints.exposed_family_count === 0 || constraints.exposed_family_count === null) &&
    constraints.quarantined_count === 0
  );
}

/**
 * Latest selection_miss per knowledge inside the supply evidence window whose
 * recorded gap is still open. A bad payload is skipped. A miss closes only when
 * its recorded evidence proves an unconstrained empty pool (known absolute-empty
 * reason + known selection policy + consistent zero candidate count) and the KC
 * now has a canonically servable member; constrained reasons, unknown policy
 * versions, and ambiguous constraint shapes stay open.
 */
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
  // Fulfillment = same current eligible pool the variant-rotation prefetch
  // serves from (kernel servable-pool membership). Only a proven unconstrained
  // empty miss closes on memberCount > 0; the event row is kept either way, so
  // a pool that drains before the window expires resurfaces on the next read.
  const membership = await readServablePoolMembership(
    db,
    demands.map((demand) => demand.miss.knowledge_id),
  );
  return demands.filter(
    (demand) =>
      !(
        isConsistentAbsoluteEmpty(demand.miss) &&
        (membership.memberCount.get(demand.miss.knowledge_id) ?? 0) > 0
      ),
  );
}
