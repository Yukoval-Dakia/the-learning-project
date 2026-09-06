/** Practice-owned attribution rewrites used by the knowledge merge workflow.
 *
 * Knowledge owns the merge transaction and its receipt; it does not own the
 * shape or write rules of question/learning-item attribution.  Keeping these
 * writes here gives both the live accept path and repair jobs one owner.
 */
import { eq, sql } from 'drizzle-orm';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';

export async function rewriteQuestionKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
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
): Promise<string[]> {
  const rows = await tx
    .select({ id: learning_item.id, knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(sql`${learning_item.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
  const rewritten: string[] = [];
  for (const row of rows) {
    const next = applyKnowledgeMergeToIds(row.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(learning_item).set({ knowledge_ids: next }).where(eq(learning_item.id, row.id));
    rewritten.push(row.id);
  }
  return rewritten;
}
