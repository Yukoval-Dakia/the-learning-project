// YUK-471 W1 PR-A2a — projectKnowledgeNode: the IO shell around the PURE node fold.
//
// This is the read→fold→write-through shell that PR-B will flip the live accept path
// to as the SOLE writer of a `knowledge` row. It:
//   1. GATHERS the superset of `event` rows that can affect `nodeId` (the pure reducer
//      filters internally, but the shell must over-collect, not under-collect — a
//      missed event silently drops a mutation from the projection),
//   2. maps each DB row → the flat FoldEvent envelope,
//   3. calls foldKnowledgeNode(nodeId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected columns.
//
// BEHAVIOR-PRESERVING (PR-A2a): this shell is ADDED + DB-tested but NOT yet called by
// acceptProposal / actions.ts / any live write path (no double-write, no SoT flip —
// those are PR-A2b / PR-B). Do not wire it in here.
//
// ── The gather problem (why three queries + a rate resolution) ──────────────────────
// Most node mutations key on the event's own `subject_id` (reparent / archive / auto_tag
// → subject_id IS the node id; merge-as-into → subject_id IS the into node; split-as-from
// → subject_id IS the source node; genesis → subject_id IS the row id). Those are Q1.
//
// But two CREATE shapes mint a node id that is NOT the event subject_id:
//   - propose_new: subject_kind='knowledge', subject_id = the PROPOSAL id (not the node);
//     the minted node id lives in the accepting RATE's payload.materialized_ids.knowledge[0].
//   - split: subject_id = the SOURCE node (from_id); the new node ids live in the accepting
//     RATE's payload.materialized_ids.knowledge (order matches payload.into[]).
// For a node BORN this way, no event has subject_id === nodeId, so Q1 misses it entirely.
// The materialized_id_index (PR-A2a Index phase) maps nodeId → its anchor event id; Q2
// pulls that anchor event PLUS everything caused_by it (the anchor's accepting rate).
//
// And one ARCHIVE shape keys on ANOTHER node: when nodeId is merged INTO another node,
// the merge event's subject_id is the into_id, and nodeId only appears in payload.from_ids.
// Q3 finds that merge via a jsonb-containment scan on payload->'from_ids'.
//
// Finally the reducer needs the RATE events (accepted-only gate + materialized_ids +
// accept-time stamp), so after gathering the propose/mutation events we fetch the rates
// chained to them (caused_by_event_id IN gathered-ids).
//
// Db|Tx polymorphic; upsert/DELETE shape mirrors upsertFsrsState (src/server/fsrs/state.ts)
// + restore-snapshot.ts's before!=null upsert / before=null DELETE branch.
//
// The read→fold half (the Q1/Q2/Q3 + rate gather described above) lives in the SHARED
// gather.ts so this shell and scripts/audit-projection.ts reconstruct a row IDENTICALLY —
// a single gather implementation means the drift auditor can never be blind to a gather bug
// in the SoT path. This shell adds only the WRITE-THROUGH on top of that shared read→fold.

import { eq } from 'drizzle-orm';

import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { gatherAndFoldKnowledgeNode } from './gather';
// YUK-471 W1 PR-B — the keystone non-delete guard reuses A2b's genesis-anchor check.
import { hasKnowledgeNodeGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current structural state of a single `knowledge` node from the event log
 * and write it through to the live `knowledge` table.
 *
 * READ→FOLD→WRITE-THROUGH:
 *   - gather the superset of events affecting `nodeId` (Q1 subject-keyed + Q2 reverse-index
 *     anchor + Q3 merged-into-another + the chained rates),
 *   - dedup by event id (the queries overlap), map → FoldEvent[],
 *   - foldKnowledgeNode(nodeId, foldEvents) (PURE),
 *   - null  → DELETE FROM knowledge WHERE id=nodeId (node never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target knowledge.id) the projected columns.
 *
 * embed_* (embedding / embed_model / embed_version / embed_content_hash) are EXCLUDED from
 * the upsert SET — they are DERIVED maintenance state the fold does not own (nightly
 * embed_backfill / reparent recompute). On a fresh INSERT they are left at their column
 * defaults (NULL); on an UPDATE they are preserved untouched (not in the SET clause).
 *
 * @param db      Db or Tx (polymorphic — PR-B calls it inside the accept tx).
 * @param nodeId  the knowledge row id to project.
 */
export async function projectKnowledgeNode(db: DbLike, nodeId: string): Promise<void> {
  // ── Read→fold (shared, READ-ONLY) ────────────────────────────────────────────────────
  // The Q1 (subject-keyed) + Q2 (reverse-index anchor) + Q3 (merged-into) + rate gather and
  // the PURE foldKnowledgeNode call live in gather.ts so the auditor reconstructs the row
  // the SAME way (single gather implementation — see gather.ts header).
  const projected = await gatherAndFoldKnowledgeNode(db, nodeId);

  // ── Write-through ────────────────────────────────────────────────────────────────────
  if (projected === null) {
    // The node was never created, or every mutation that would create it was un-accepted /
    // reverted → the live row must not exist. DELETE (inverse of the create INSERT).
    await db.delete(knowledge).where(eq(knowledge.id, nodeId));
    return;
  }
  await upsertProjectedKnowledgeNode(db, projected);
}

/**
 * YUK-471 W1 PR-B — the GUARDED node write-through (the SoT-flip row writer). Identical to
 * projectKnowledgeNode EXCEPT the null branch: a fold of null DELETEs the live row ONLY when
 * the node HAS a genesis anchor (a genuine revert of an event-sourced node). A fold-null on an
 * UN-anchored node — a seed root or any pre-event-sourced row the fold is blind to — must NOT
 * delete the live row; that would destroy data on a normal merge/reparent/archive whose target
 * predates event-sourcing. This is the keystone that lets the flip be activated before every
 * node is backfilled: under the flip the accept seam calls THIS for every touched node, so a
 * mutation against an un-backfilled node leaves its imperative row intact instead of deleting it.
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

// Shared upsert of the projected STRUCTURAL columns. embed_* are deliberately omitted from BOTH
// the INSERT values (left at NULL default on a fresh row) and the UPDATE set (preserved on an
// existing row) — the fold does not own derived embedding state.
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
