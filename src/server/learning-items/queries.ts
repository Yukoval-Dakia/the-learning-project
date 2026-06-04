// YUK-203 U4 / D11① — active learning-item reader for the Coach brief.
//
// Models src/server/goals/queries.ts:listActiveGoals. Returns the pinned /
// in_progress learning items so the coach_daily handler can feed their
// `knowledge_ids` into the Coach input as ATTENTION PRESSURE only (D11① /
// CO §7.1:723-726) — never as scheduling / bookkeeping state. ADR-0012: this is
// a read-only ADD to the Coach signal set; it touches no FSRS / due / mastery.
//
// `learning_item.status` is plain text (default 'pending', schema.ts:221) — NOT
// a pgEnum; 'in_progress' is the live status string (verified
// proposal-tools.ts: `status !== 'pending' && status !== 'in_progress'`).
// `user_pinned` is a boolean (default false, schema.ts:222).

import { asc, eq, or } from 'drizzle-orm';

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
 * Active learning items = `status = 'in_progress'` OR `user_pinned = true`.
 * Ordered by created_at for a stable feed. Read-only; writes nothing (ND-5 /
 * D11: attention pressure, never bookkeeping).
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
    .where(or(eq(learning_item.status, 'in_progress'), eq(learning_item.user_pinned, true)))
    .orderBy(asc(learning_item.created_at), asc(learning_item.id));
  return rows.map((r) => ({
    id: r.id,
    knowledge_ids: r.knowledge_ids ?? [],
    status: r.status,
    user_pinned: r.user_pinned,
  }));
}
