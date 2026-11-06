// Structural write-through for knowledge nodes, plus the id preparation that every
// node-creating owner runs before its creation event. History and anchor facts are
// shared with parity and replay; embed_* remains derived maintenance state outside this write.

import { and, eq, isNull } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { sanitizeProposedNodeDomain } from '@/subjects/profile';
import {
  gatherAndFoldKnowledgeNode,
  hasKnowledgeNodeGenesisAnchor,
} from './knowledge-node-history';

type DbLike = Db | Tx;

/**
 * Parent existence check for node creation. `FOR SHARE` waits for an in-flight
 * archive and then re-checks `archived_at`, so creating a child and archiving the
 * parent cannot interleave; callers must supply the transaction that will insert
 * the child row.
 */
export async function assertKnowledgeParentExists(tx: Tx, parentId: string): Promise<void> {
  const row = (
    await tx
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.id, parentId), isNull(knowledge.archived_at)))
      .for('share')
      .limit(1)
  )[0];
  if (!row) {
    throw new Error(`parent knowledge node not found or archived: ${parentId}`);
  }
}

// Shared preparation for explicit acceptance and automatic tagging. It does not
// write a node: each owner records its creation contract before projection.
export async function prepareProposedKnowledgeId(
  tx: Tx,
  payload: { parent_id: string | null; domain?: string },
): Promise<string> {
  // Root creation has no parent to assert; the projected row stamps payload.domain.
  // Re-check defensively: 'general'/blank can never persist as a node domain.
  if (payload.parent_id === null) {
    if (!sanitizeProposedNodeDomain(payload.domain)) {
      throw new Error(
        "propose_new root creation requires a selectable payload.domain — 'general'/blank is a fallback identity, not a node domain",
      );
    }
    return newId();
  }
  await assertKnowledgeParentExists(tx, payload.parent_id);
  return newId();
}

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
      role: projected.role ?? 'kc',
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
        role: projected.role ?? 'kc',
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}
