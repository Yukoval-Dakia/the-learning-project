// Reference answer failure-learning owes the inbox's batch-undo guard: a live
// misconception edge anchored on a knowledge node is later content, so retracting
// that auto-created node would orphan the edge. Reads the owner's rows only.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { misconception_edge } from '@/db/schema/knowledge';

type DbLike = Db | Tx;

/** Knowledge nodes a live misconception edge still points at. */
export async function knowledgeNodesWithMisconceptionEdges(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await db
    .select({ nodeId: misconception_edge.to_id })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.to_kind, 'knowledge'),
        inArray(misconception_edge.to_id, [...nodeIds]),
        isNull(misconception_edge.archived_at),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    if (row.nodeId) used.add(row.nodeId);
  }
  return used;
}
