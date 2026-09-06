/** Agency-owned goal scope rewrite used by knowledge merge orchestration. */
import { sql } from 'drizzle-orm';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import type { Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { updateGoalScope } from './queries';

export async function rewriteGoalScopeOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select({ id: goal.id, scope_knowledge_ids: goal.scope_knowledge_ids })
    .from(goal)
    .where(sql`${goal.scope_knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
  const rewritten: string[] = [];
  for (const row of rows) {
    const next = applyKnowledgeMergeToIds(row.scope_knowledge_ids ?? [], new Set([fromId]), intoId);
    await updateGoalScope(tx, row.id, { scope_knowledge_ids: next }, now);
    rewritten.push(row.id);
  }
  return rewritten;
}
