// Reference answers settlement owes the inbox's batch-undo guard.
//
// A learning record is later content: once a record cites a knowledge node or a
// learning item, retracting the auto-applied effect would orphan it. The queries
// read the owner's live rows only; the guard owns what the answer means.

import { and, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_record } from '@/db/schema';

type DbLike = Db | Tx;

/** Live records whose `knowledge_ids` include the node. */
export async function knowledgeNodesWithLearningRecords(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return new Set();
  const rows = await db
    .select({ knowledgeIds: learning_record.knowledge_ids })
    .from(learning_record)
    .where(
      and(
        isNull(learning_record.archived_at),
        or(
          ...[...wanted].map(
            (id) => sql`${learning_record.knowledge_ids} @> jsonb_build_array(${id}::text)`,
          ),
        ),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    for (const id of row.knowledgeIds ?? []) {
      if (wanted.has(id)) used.add(id);
    }
  }
  return used;
}

/** Live records attached to the learning item. */
export async function learningItemsWithLearningRecords(
  db: DbLike,
  itemIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db
    .select({ learningItemId: learning_record.learning_item_id })
    .from(learning_record)
    .where(
      and(
        inArray(learning_record.learning_item_id, [...itemIds]),
        isNull(learning_record.archived_at),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    if (row.learningItemId) used.add(row.learningItemId);
  }
  return used;
}
