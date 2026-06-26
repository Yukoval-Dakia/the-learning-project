// YUK-471 W3-B1 — projectArtifact: the IO shell around the PURE artifact fold.
//
// The read→fold→write-through shell the artifact write sites (the 8 INSERT sites /
// editArtifactBodyBlocks / note_generate·note_verify / retract archive / persistNoteRefineApply)
// flip to as the SOLE writer of an `artifact` row WHEN the per-entity flag
// projectionIsWriter('artifact') is ON (design §6, added in C3). It:
//   1. GATHERS the superset of `event` rows that can affect `artifactId` (the pure reducer filters
//      internally, but the shell over-collects — a missed event silently drops a mutation),
//   2. maps each DB row → the flat FoldEvent envelope,
//   3. calls foldArtifact(artifactId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected columns.
//
// artifact has NO derived/embed columns (unlike knowledge's embed_*), so the upsert covers the
// FULL row — every one of its 22 columns is fold truth (design §5.1).
//
// ── INERT (W3-B1, behaviour-preserving) ────────────────────────────────────────────────────────
// This shell is ADDED but NOT yet called by any live write path (no double-write, no SoT flip —
// those are W3-C1/C3). The guarded variant in particular must NOT delete a pre-W3 row that folds to
// null: until backfill (C2) writes a genesis anchor for every artifact, a fold-null on an
// un-anchored row is fold-BLINDNESS, not a revert, so the guard keeps the imperative row.
//
// ── Gather + anchor HOISTED to the shared modules (W3-C2) ───────────────────────────────────────
// The W1/W2 IO shells import gatherAndFoldX from the SHARED gather.ts (so the projection auditor
// reconstructs a row identically) and hasXGenesisAnchor from parity.ts. W3-B1 kept a private
// Q1-only gather + event-table anchor here while inert; C2 HOISTS them into gather.ts
// (gatherAndFoldArtifact) and parity.ts (hasArtifactGenesisAnchor — now WITH the materialized_id_index
// leg, since artifact enters the index in C2, design §5.3) so the auditor + backfill share ONE gather
// and ONE anchor definition with this shell. This shell now just imports them.
//
// Db|Tx polymorphic.

import { eq } from 'drizzle-orm';

import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { gatherAndFoldArtifact } from './gather';
import { hasArtifactGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current structural state of a single `artifact` from the event log and write it
 * through to the live `artifact` table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM artifact WHERE id=artifactId (artifact never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target artifact.id) the projected columns.
 *
 * INERT in B1 (not wired into any live path). Db|Tx polymorphic (wired sites in C1/C3 call it
 * inside the write tx).
 *
 * @param db          Db or Tx (polymorphic).
 * @param artifactId  the artifact row id to project.
 */
export async function projectArtifact(db: DbLike, artifactId: string): Promise<void> {
  const projected = await gatherAndFoldArtifact(db, artifactId);
  if (projected === null) {
    await db.delete(artifact).where(eq(artifact.id, artifactId));
    return;
  }
  await upsertProjectedArtifact(db, projected);
}

/**
 * The GUARDED artifact write-through (the SoT-flip row writer). Identical to projectArtifact EXCEPT
 * the null branch: a fold of null DELETEs the live row ONLY when the artifact HAS a genesis/create
 * anchor (a genuine revert of an event-sourced artifact). A fold-null on an UN-anchored artifact —
 * a pre-W3 row the fold is blind to (no genesis backfill yet) — must NOT delete the live row; that
 * would destroy data on a normal edit/lifecycle whose target predates event-sourcing. This is the
 * keystone that lets the flip activate before every artifact is backfilled. Mirrors
 * projectKnowledgeNodeGuarded / projectGoalGuarded.
 */
export async function projectArtifactGuarded(db: DbLike, artifactId: string): Promise<void> {
  const projected = await gatherAndFoldArtifact(db, artifactId);
  if (projected === null) {
    if (await hasArtifactGenesisAnchor(db, artifactId)) {
      // Genuine revert — the artifact was event-sourced and every creating event un-applied.
      await db.delete(artifact).where(eq(artifact.id, artifactId));
    }
    // else: fold-blind pre-event-sourced artifact — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedArtifact(db, projected);
}

// Shared upsert of the projected artifact columns (the FULL 22-column row — no derived/excluded
// columns, design §5.1). body_blocks / tool_state / verification_summary / generated_by /
// verified_by may be null; knowledge_ids / attrs / history have table defaults but the fold always
// carries an explicit value (the snapshot is the full row).
async function upsertProjectedArtifact(db: DbLike, projected: ArtifactRowSnapshotT): Promise<void> {
  const values = {
    id: projected.id,
    type: projected.type,
    title: projected.title,
    parent_artifact_id: projected.parent_artifact_id,
    knowledge_ids: projected.knowledge_ids,
    intent_source: projected.intent_source,
    source: projected.source,
    source_ref: projected.source_ref,
    body_blocks: projected.body_blocks,
    attrs: projected.attrs,
    tool_kind: projected.tool_kind,
    tool_state: projected.tool_state,
    generation_status: projected.generation_status,
    verification_status: projected.verification_status,
    verification_summary: projected.verification_summary,
    generated_by: projected.generated_by,
    verified_by: projected.verified_by,
    history: projected.history,
    archived_at: projected.archived_at,
    created_at: projected.created_at,
    updated_at: projected.updated_at,
    version: projected.version,
  } as typeof artifact.$inferInsert;
  await db
    .insert(artifact)
    .values(values)
    .onConflictDoUpdate({
      target: artifact.id,
      set: {
        type: projected.type,
        title: projected.title,
        parent_artifact_id: projected.parent_artifact_id,
        knowledge_ids: projected.knowledge_ids,
        intent_source: projected.intent_source,
        source: projected.source,
        source_ref: projected.source_ref,
        body_blocks: projected.body_blocks,
        attrs: projected.attrs,
        tool_kind: projected.tool_kind,
        tool_state: projected.tool_state,
        generation_status: projected.generation_status,
        verification_status: projected.verification_status,
        verification_summary: projected.verification_summary,
        generated_by: projected.generated_by,
        verified_by: projected.verified_by,
        history: projected.history,
        archived_at: projected.archived_at,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      } as Partial<typeof artifact.$inferInsert>,
    });
}
