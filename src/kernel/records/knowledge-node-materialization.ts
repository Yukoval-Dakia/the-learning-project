// Structural write-through for knowledge nodes. History and anchor facts are shared
// with parity and replay; embed_* remains derived maintenance state outside this write.

import { eq } from 'drizzle-orm';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import {
  gatherAndFoldKnowledgeNode,
  hasKnowledgeNodeGenesisAnchor,
} from './knowledge-node-history';

type DbLike = Db | Tx;

/**
 * Re-project one `knowledge` node. A fold of null deletes the row; otherwise upsert the
 * structural columns and leave embed_* untouched.
 */
export async function projectKnowledgeNode(db: DbLike, nodeId: string): Promise<void> {
  const projected = await gatherAndFoldKnowledgeNode(db, nodeId);

  if (projected === null) {
    // Never created, or every creating mutation was un-accepted / reverted.
    await db.delete(knowledge).where(eq(knowledge.id, nodeId));
    return;
  }
  await upsertProjectedKnowledgeNode(db, projected);
}

/**
 * Guarded write-through: a fold of null deletes only when the node has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
 */
export async function projectKnowledgeNodeGuarded(db: DbLike, nodeId: string): Promise<void> {
  const projected = await gatherAndFoldKnowledgeNode(db, nodeId);
  if (projected === null) {
    if (await hasKnowledgeNodeGenesisAnchor(db, nodeId)) {
      // Genuine revert — the node was event-sourced and every creating mutation un-accepted.
      await db.delete(knowledge).where(eq(knowledge.id, nodeId));
    }
    // else: fold-blind pre-event-sourced node — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedKnowledgeNode(db, projected);
}

// Upsert the structural columns only. embed_* is left at its default on insert and
// untouched on update because the fold does not own it.
async function upsertProjectedKnowledgeNode(
  db: DbLike,
  projected: KnowledgeRowSnapshotT,
): Promise<void> {
  await db
    .insert(knowledge)
    .values({
      id: projected.id,
      name: projected.name,
      domain: projected.domain,
      parent_id: projected.parent_id,
      merged_from: projected.merged_from,
      archived_at: projected.archived_at,
      proposed_by_ai: projected.proposed_by_ai,
      approval_status: projected.approval_status,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
      version: projected.version,
    })
    .onConflictDoUpdate({
      target: knowledge.id,
      set: {
        name: projected.name,
        domain: projected.domain,
        parent_id: projected.parent_id,
        merged_from: projected.merged_from,
        archived_at: projected.archived_at,
        proposed_by_ai: projected.proposed_by_ai,
        approval_status: projected.approval_status,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}
