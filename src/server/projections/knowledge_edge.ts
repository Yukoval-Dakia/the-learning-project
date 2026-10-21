// Write-through shell for the pure `knowledge_edge` fold. Every edge event keys on the
// edge id, so the gather is a single subject-keyed query. The fold also receives the
// live edge mesh for its topology checks; a topology reject propagates and aborts the
// caller's transaction. The shared gather lives in gather.ts.

import { eq, inArray } from 'drizzle-orm';

import { isDirectTreePair } from '@/capabilities/knowledge/public';
import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { gatherAndFoldKnowledgeEdge } from './gather';

type DbLike = Db | Tx;
type EdgeRow = typeof knowledge_edge.$inferSelect;
// created_by type comes from the table's inferred shape, avoiding a cross-import of the alias.
type EdgeCreatedBy = EdgeRow['created_by'];

/**
 * Re-project one `knowledge_edge`. A fold of null deletes the row; otherwise upsert.
 * A topology reject propagates so the caller's transaction aborts.
 */
export async function projectKnowledgeEdge(db: DbLike, edgeId: string): Promise<void> {
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId);

  if (projected === null) {
    await db.delete(knowledge_edge).where(eq(knowledge_edge.id, edgeId));
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

/**
 * Guarded write-through: an edge folds to null only without a create event, which means
 * a legacy row the fold cannot see, so this variant never deletes.
 */
export async function projectKnowledgeEdgeGuarded(db: DbLike, edgeId: string): Promise<void> {
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId);
  if (projected === null) {
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

// Upsert the full row; the table has no version or embed_* columns.
async function upsertProjectedKnowledgeEdge(
  db: DbLike,
  projected: KnowledgeEdgeRowSnapshotT,
): Promise<void> {
  if (projected.archived_at === null) {
    const endpointRows = await db
      .select({ id: knowledge.id, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(inArray(knowledge.id, [projected.from_knowledge_id, projected.to_knowledge_id]));
    if (
      isDirectTreePair(
        projected.from_knowledge_id,
        projected.to_knowledge_id,
        endpointRows.flatMap((node) =>
          node.parent_id ? [{ child_id: node.id, parent_id: node.parent_id }] : [],
        ),
      )
    ) {
      throw new Error(
        `projectKnowledgeEdge: tree redundancy for ${projected.from_knowledge_id} ↔ ${projected.to_knowledge_id}`,
      );
    }
  }

  await db
    .insert(knowledge_edge)
    .values({
      id: projected.id,
      from_knowledge_id: projected.from_knowledge_id,
      to_knowledge_id: projected.to_knowledge_id,
      relation_type: projected.relation_type,
      weight: projected.weight,
      created_by: projected.created_by as unknown as EdgeCreatedBy,
      reasoning: projected.reasoning,
      created_at: projected.created_at,
      archived_at: projected.archived_at,
    })
    .onConflictDoUpdate({
      target: knowledge_edge.id,
      set: {
        from_knowledge_id: projected.from_knowledge_id,
        to_knowledge_id: projected.to_knowledge_id,
        relation_type: projected.relation_type,
        weight: projected.weight,
        created_by: projected.created_by as unknown as EdgeCreatedBy,
        reasoning: projected.reasoning,
        created_at: projected.created_at,
        archived_at: projected.archived_at,
      },
    });
}
