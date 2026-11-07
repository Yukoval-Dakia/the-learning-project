// Reference answer supply owes the inbox's batch-undo guard: a placement starter
// claim still needs its knowledge node, so retracting that auto-created node would
// break the claim. Reads the owner's rows only.

import { inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { placement_starter_claim } from '@/db/schema/learner-state';

type DbLike = Db | Tx;

/** Knowledge nodes a placement starter claim still points at. */
export async function knowledgeNodesWithPlacementClaims(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await db
    .select({ knowledgeId: placement_starter_claim.knowledge_id })
    .from(placement_starter_claim)
    .where(inArray(placement_starter_claim.knowledge_id, [...nodeIds]));
  const used = new Set<string>();
  for (const row of rows) {
    if (row.knowledgeId) used.add(row.knowledgeId);
  }
  return used;
}
