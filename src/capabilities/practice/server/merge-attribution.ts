/** Practice-owned attribution rewrites used by the knowledge merge workflow.
 *
 * Knowledge owns the merge transaction and its receipt; it does not own the
 * shape or write rules of question/learning-item attribution.  Keeping these
 * writes here gives both the live accept path and repair jobs one owner.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import {
  assertLearningItemParity,
  learningItemLiveRowToSnapshot,
  learningItemsWithGenesisAnchor,
} from '@/server/projections/parity';

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
): Promise<string[]> {
  const rows = await tx
    .select({ id: learning_item.id, knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(sql`${learning_item.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`)
    .orderBy(asc(learning_item.id))
    .for('update');
  const rewritten: string[] = [];
  for (const row of rows) {
    const next = applyKnowledgeMergeToIds(row.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(learning_item).set({ knowledge_ids: next }).where(eq(learning_item.id, row.id));
    rewritten.push(row.id);
  }
  return rewritten;
}

/** Called only after the merge acceptance event exists; unanchored legacy items are preserved.
 * Attribution repair deliberately changes neither version nor updated_at, matching the reducer.
 * The live merge and historical repair share that rule. Projection migration remains owner-private.
 */
export async function assertMergedLearningItemParity(
  tx: Tx,
  ids: readonly string[],
): Promise<void> {
  const touched = [...new Set(ids)];
  if (touched.length === 0) return;
  const anchored = await learningItemsWithGenesisAnchor(tx, touched);
  if (anchored.size === 0) return;
  const rows = await tx.select().from(learning_item).where(inArray(learning_item.id, touched));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of anchored) {
    const live = byId.get(id);
    await assertLearningItemParity(tx, id, live ? learningItemLiveRowToSnapshot(live) : null);
  }
}
