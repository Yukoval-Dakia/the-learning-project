// Reference answer the practice session face owes the inbox's batch-undo guard:
// an unsubmitted answer draft is in-flight learner work, so retracting the
// auto-created learning item would interrupt it. Reads the owner's rows only.

import { and, inArray, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { answer } from '@/db/schema/learning';

type DbLike = Db | Tx;

/** Learning items that still hold an unsubmitted answer draft. */
export async function learningItemsWithAnswerDrafts(
  db: DbLike,
  itemIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db
    .select({ learningItemId: answer.learning_item_id })
    .from(answer)
    .where(and(inArray(answer.learning_item_id, [...itemIds]), isNull(answer.submitted_at)));
  const used = new Set<string>();
  for (const row of rows) {
    if (row.learningItemId) used.add(row.learningItemId);
  }
  return used;
}
