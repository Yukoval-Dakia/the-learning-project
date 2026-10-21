// Write-through shell for the pure `artifact` fold: gather the event superset, fold
// it, then delete or upsert the live row. The shell over-collects because a missed
// event would silently drop a mutation. `artifact` has no derived columns, so the
// upsert writes the full row.

import { eq } from 'drizzle-orm';

import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { gatherAndFoldArtifact } from './gather';
import { hasArtifactGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Re-project one `artifact` from the event log into the live table. A fold of null
 * deletes the row; otherwise the projected columns are upserted.
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
 * Guarded write-through: a fold of null deletes only when the artifact has a genesis
 * anchor. Without one the fold is blind to a pre-event row, so deleting would lose data.
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

// Upsert every projected column; `artifact` has no derived or excluded columns.
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
