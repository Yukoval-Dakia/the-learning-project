/** Practice-owned attribution rewrites used by the knowledge merge workflow.
 *
 * Knowledge owns the merge transaction and its receipt; it does not own the
 * shape or write rules of question/learning-item attribution.  Keeping these
 * writes here gives both the live accept path and repair jobs one owner.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import { applyLearningItemRepair } from '@/server/projections/learning_item';

export async function rewriteQuestionKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`)
    .orderBy(asc(question.id))
    .for('update');
  const rewritten: string[] = [];
  for (const row of rows) {
    const next = applyKnowledgeMergeToIds(row.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(question).set({ knowledge_ids: next }).where(eq(question.id, row.id));
    rewritten.push(row.id);
  }
  return rewritten;
}

export async function rewriteLearningItemKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
): Promise<string[]> {
  if (fromId === intoId) return [];
  const rows = await tx
    .select({ id: learning_item.id, knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(sql`${learning_item.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`)
    .orderBy(asc(learning_item.id))
    .for('update');
  const rewritten: string[] = [];
  for (const row of rows) {
    await applyLearningItemRepair(
      tx,
      {
        actor_kind: 'system',
        actor_ref: 'learning-item-attribution-repair',
        action: 'experimental:learning_item_knowledge_ids_rewrite',
        subject_kind: 'learning_item',
        subject_id: row.id,
        outcome: 'success',
        payload: { from_id: fromId, into_id: intoId },
      },
      now,
    );
    rewritten.push(row.id);
  }
  return rewritten;
}
