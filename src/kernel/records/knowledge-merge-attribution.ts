/** Structural knowledge attribution repair for questions and learning items.
 * The caller owns the transaction and cross-surface repair order.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { KNOWLEDGE_MERGE_REWRITE_REASON } from '@/kernel/proposals/node-question-attachments';
import { applyLearningItemRepair } from './learning-items';

export async function rewriteQuestionKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: question.id, knowledge_ids: question.knowledge_ids, version: question.version })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`)
    .orderBy(asc(question.id))
    .for('update');
  const rewritten: string[] = [];
  for (const row of rows) {
    const next = applyKnowledgeMergeToIds(row.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(question).set({ knowledge_ids: next }).where(eq(question.id, row.id));
    // The merge rewrite does not bump question.version, so this event is the
    // only record of the attribution change; the auto-ownership proof reads it
    // to keep merge-placed attachments from looking machine-born.
    await writeEvent(tx, {
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'knowledge-merge-attribution',
      action: QUESTION_EDIT_ACTION,
      subject_kind: 'question',
      subject_id: row.id,
      outcome: 'success',
      payload: {
        question_id: row.id,
        previous_version: row.version,
        next_version: row.version,
        before: { knowledge_ids: row.knowledge_ids ?? [] },
        after: { knowledge_ids: next },
        reason: KNOWLEDGE_MERGE_REWRITE_REASON,
        from_id: fromId,
        into_id: intoId,
      },
    });
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
