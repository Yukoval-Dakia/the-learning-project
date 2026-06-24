// YUK-471 W1 PR-A2a — projectKnowledgeEdge: the IO shell around the PURE edge fold.
//
// The read→fold→write-through shell for a `knowledge_edge` row. Unlike the node shell,
// edges are SIMPLE: EVERY edge event (genesis seed, generate-create, generate-archive)
// keys on the edge's own subject_id (= edgeId). So the gather is a single subject-keyed
// query — no reverse index, no jsonb-containment scan, no rate resolution (the edge
// reducer reads no rate events; edge create/archive take effect directly).
//
// The reducer DOES need the live topology mesh: a generate-create that adds a LIVE
// prerequisite edge is re-checked against ADR-0034 (cycle / direction contradiction). The
// shell supplies liveMesh = the current archived_at IS NULL edge set. NOTE: foldKnowledgeEdge
// THROWS on a topology reject — we let it PROPAGATE so the caller's transaction aborts (in
// PR-B this shell runs inside the accept tx; a reject must roll the whole accept back, not
// leave a half-applied edge). The shell does not catch it.
//
// BEHAVIOR-PRESERVING (PR-A2a): ADDED + DB-tested, NOT wired into edges.ts / propose_edge.ts
// / any live write path. Db|Tx polymorphic; upsert/DELETE mirrors upsertFsrsState +
// restore-snapshot.ts.
//
// The read→fold half (the subject-keyed gather + liveMesh + foldKnowledgeEdge call) lives in
// the SHARED gather.ts so this shell and scripts/audit-projection.ts reconstruct an edge
// IDENTICALLY (single gather implementation — see gather.ts header). This shell adds only
// the WRITE-THROUGH.

import { eq } from 'drizzle-orm';

import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { gatherAndFoldKnowledgeEdge } from './gather';

type DbLike = Db | Tx;
type EdgeRow = typeof knowledge_edge.$inferSelect;
// created_by column type, sourced from the table's own inferred shape (jsonb $type<AgentRefT>)
// — avoids a cross-import of the non-exported AgentRefT alias.
type EdgeCreatedBy = EdgeRow['created_by'];

/**
 * Project a single `knowledge_edge` row from its event log and write it through to the live
 * `knowledge_edge` table.
 *
 * READ→FOLD→WRITE-THROUGH:
 *   - gather events WHERE subject_kind='knowledge_edge' AND subject_id=edgeId (all edge
 *     events key on edgeId — genesis / generate-create / generate-archive),
 *   - build liveMesh = the current live edge set (archived_at IS NULL) as the topology fixture,
 *   - foldKnowledgeEdge(edgeId, foldEvents, liveMesh) (PURE; THROWS on ADR-0034 reject),
 *   - null → DELETE FROM knowledge_edge WHERE id=edgeId,
 *   - row  → upsert (insert … onConflictDoUpdate target knowledge_edge.id).
 *
 * @param db      Db or Tx (polymorphic).
 * @param edgeId  the knowledge_edge row id to project.
 * @throws when a generate-create adds a LIVE prerequisite edge that closes a cycle or
 *         reverses an existing prerequisite (foldKnowledgeEdge's ADR-0034 reject). The error
 *         is NOT caught — it propagates so the caller's transaction aborts (PR-B accept tx).
 */
export async function projectKnowledgeEdge(db: DbLike, edgeId: string): Promise<void> {
  // ── Read→fold (shared, READ-ONLY; may THROW on topology reject — let it propagate) ───
  // The subject-keyed gather + liveMesh build + PURE foldKnowledgeEdge call live in
  // gather.ts so the auditor reconstructs the edge the SAME way (see gather.ts header).
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId);

  // ── Write-through ────────────────────────────────────────────────────────────────────
  if (projected === null) {
    await db.delete(knowledge_edge).where(eq(knowledge_edge.id, edgeId));
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

/**
 * YUK-471 W1 PR-B — the GUARDED edge write-through (the SoT-flip edge writer). Same as
 * projectKnowledgeEdge EXCEPT the null branch DELETEs only when the edge HAS a creating event
 * (genesis / generate) — a genuine revert. A fold-null on an edge with NO event (a
 * pre-event-sourced edge, e.g. one written by the public POST /edges path that emits no event)
 * must NOT be deleted. In practice an event-sourced edge never folds to null (a generate-create
 * always yields a non-null row, archived or not), so this guard fires only for truly un-anchored
 * edges — the symmetric keystone to the node guard and the safety net for a rebuild over
 * un-migrated edges. Like projectKnowledgeEdge it lets a topology reject from the fold propagate.
 */
export async function projectKnowledgeEdgeGuarded(db: DbLike, edgeId: string): Promise<void> {
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId);
  if (projected === null) {
    // An edge folds to null IFF it has no CREATE event (the reducer needs a create to produce a
    // row; an archive only sets archived_at on an already-non-null row), so fold-null always
    // means a pre-event-sourced / legacy edge the fold is blind to. The GUARDED write-through
    // NEVER deletes on fold-null — only the unguarded projectKnowledgeEdge (rebuild / auditor)
    // deletes. On the accept path the edge always has its generate event this tx, so this branch
    // is unreachable there anyway.
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

// Shared upsert of the projected columns. knowledge_edge has NO version column and NO embed_*;
// the full snapshot shape is the row.
async function upsertProjectedKnowledgeEdge(
  db: DbLike,
  projected: KnowledgeEdgeRowSnapshotT,
): Promise<void> {
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
