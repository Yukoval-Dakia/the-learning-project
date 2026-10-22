// Read-only active learning-item reader for the Coach brief. Results are attention
// pressure only: this module never reads or writes scheduling, due, mastery, or
// bookkeeping state. `status` is free text; 'in_progress' is the live value.

import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_item } from '@/db/schema';

type DbLike = Db | Tx;

export interface ActiveLearningItem {
  id: string;
  knowledge_ids: string[];
  status: string;
  user_pinned: boolean;
}

/**
 * Active items are not archived and are either in progress or pinned, oldest first.
 * The `archived_at` guard is explicit because archiving only sets that column; it
 * leaves status and pin intact, so a just-archived item would still match.
 */
export async function listActiveLearningItems(db: DbLike): Promise<ActiveLearningItem[]> {
  const rows = await db
    .select({
      id: learning_item.id,
      knowledge_ids: learning_item.knowledge_ids,
      status: learning_item.status,
      user_pinned: learning_item.user_pinned,
    })
    .from(learning_item)
    .where(
      and(
        isNull(learning_item.archived_at),
        or(eq(learning_item.status, 'in_progress'), eq(learning_item.user_pinned, true)),
      ),
    )
    .orderBy(asc(learning_item.created_at), asc(learning_item.id));
  return rows.map((r) => ({
    id: r.id,
    knowledge_ids: r.knowledge_ids ?? [],
    status: r.status,
    user_pinned: r.user_pinned,
  }));
}
