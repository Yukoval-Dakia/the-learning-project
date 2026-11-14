// Deterministic reuse and prerequisite facts for learning-intent planning.
// The orchestrator owns proposal/accept behavior; this module owns only bounded reads.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { artifact, knowledge_edge, learning_item } from '@/db/schema';
import { artifactReuseAllowed } from '@/kernel/read-models/usage-policy';
import type { LearningItemRecord } from '@/kernel/records/learning-items';

export interface ExistingLearningIntentItemSnapshot {
  readonly item: LearningItemRecord;
  readonly note: typeof artifact.$inferSelect;
  readonly allowed: boolean;
}

export interface ExistingLearningIntentItemReference {
  readonly item_id: string;
  readonly note_id: string;
}

export interface LearningIntentPrerequisiteEdge {
  prerequisite_knowledge_id: string;
  dependent_knowledge_id: string;
}

export async function readExistingItemSnapshots(
  db: Db,
  topicNode: { id: string } | null,
  children: readonly { id: string }[],
): Promise<Map<string, ExistingLearningIntentItemSnapshot>> {
  const knowledgeIds = new Set(
    [topicNode?.id, ...children.map((child) => child.id)].filter((id): id is string => !!id),
  );
  const out = new Map<string, ExistingLearningIntentItemSnapshot>();
  if (knowledgeIds.size === 0) return out;
  const candidates = await db
    .select()
    .from(learning_item)
    .where(
      and(
        isNull(learning_item.archived_at),
        inArray(learning_item.status, ['pending', 'in_progress', 'done']),
        sql`EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${learning_item.knowledge_ids}) AS item_knowledge_id
          WHERE item_knowledge_id IN (${sql.join(
            [...knowledgeIds].map((id) => sql`${id}`),
            sql`, `,
          )})
        )`,
      ),
    )
    .orderBy(learning_item.created_at, learning_item.id);
  for (const item of candidates) {
    const itemKnowledge = item.knowledge_ids.filter((id) => knowledgeIds.has(id));
    if (itemKnowledge.length === 0 || !item.primary_artifact_id) continue;
    const [note] = await db
      .select()
      .from(artifact)
      .where(and(eq(artifact.id, item.primary_artifact_id), isNull(artifact.archived_at)))
      .limit(1);
    if (!note) continue;
    const allowed =
      item.source_ref &&
      (await artifactReuseAllowed(
        db,
        { kind: 'event', id: item.source_ref },
        item.primary_artifact_id,
      ));
    if (!allowed) continue;
    for (const id of itemKnowledge) {
      const current = out.get(id);
      if (!current || current.item.status === 'done') out.set(id, { item, note, allowed: true });
    }
  }
  return out;
}

export async function readExistingItemReference(
  tx: Tx,
  reference: ExistingLearningIntentItemReference,
): Promise<ExistingLearningIntentItemSnapshot | null> {
  const [item] = await tx
    .select()
    .from(learning_item)
    .where(eq(learning_item.id, reference.item_id))
    .for('update');
  if (
    !item ||
    item.archived_at !== null ||
    item.dismissed_at !== null ||
    !['pending', 'in_progress', 'done'].includes(item.status) ||
    item.primary_artifact_id !== reference.note_id
  )
    return null;
  const [note] = await tx
    .select()
    .from(artifact)
    .where(eq(artifact.id, reference.note_id))
    .for('update');
  if (!note || note.archived_at !== null) return null;
  if (
    !item.source_ref ||
    !(await artifactReuseAllowed(tx, { kind: 'event', id: item.source_ref }, reference.note_id))
  )
    return null;
  return { item, note, allowed: true };
}

export async function readPrerequisiteEdges(
  db: Db,
  topicNode: { id: string } | null,
  children: readonly { id: string }[],
): Promise<LearningIntentPrerequisiteEdge[]> {
  const ids = [topicNode?.id ?? '', ...children.map((child) => child.id)];
  return db
    .select({
      prerequisite_knowledge_id: knowledge_edge.from_knowledge_id,
      dependent_knowledge_id: knowledge_edge.to_knowledge_id,
    })
    .from(knowledge_edge)
    .where(
      and(
        eq(knowledge_edge.relation_type, 'prerequisite'),
        isNull(knowledge_edge.archived_at),
        inArray(knowledge_edge.from_knowledge_id, ids),
        inArray(knowledge_edge.to_knowledge_id, ids),
      ),
    );
}

/** Stable case-insensitive key for request, paid-effect, and proposal matching. */
export function normalizeLearningIntentTopic(topic: string): string {
  return topic.trim().normalize('NFKC').toLowerCase();
}
