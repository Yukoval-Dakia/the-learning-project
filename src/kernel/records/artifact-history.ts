// Artifact history facts: gather and fold the event superset, identify genesis
// anchors, and materialize the complete structural row without opening a transaction.

import { and, eq, inArray } from 'drizzle-orm';

import { foldArtifact } from '@/core/projections/artifact';
import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { artifact, event, materialized_id_index } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

type DbLike = Db | Tx;
type ArtifactCollections = Pick<ArtifactRowSnapshotT, 'knowledge_ids' | 'attrs' | 'history'>;

// One explicit field selection serves live snapshots and both upsert branches.
// Live rows normalize the three collections before passing them here; folds do not.
function pickArtifactFields(
  row: Omit<ArtifactRowSnapshotT, keyof ArtifactCollections>,
  collections: ArtifactCollections,
): ArtifactRowSnapshotT {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    parent_artifact_id: row.parent_artifact_id,
    knowledge_ids: collections.knowledge_ids,
    intent_source: row.intent_source,
    source: row.source,
    source_ref: row.source_ref,
    body_blocks: row.body_blocks,
    attrs: collections.attrs,
    tool_kind: row.tool_kind,
    tool_state: row.tool_state,
    generation_status: row.generation_status,
    verification_status: row.verification_status,
    verification_summary: row.verification_summary,
    generated_by: row.generated_by,
    verified_by: row.verified_by,
    history: collections.history,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Map a live `artifact` DB row to ArtifactRowSnapshotT. artifact has NO derived/embed columns
 * (design §5.1), so the FULL 22-column row IS the snapshot — every column is carried verbatim. The
 * jsonb columns (body_blocks / attrs / tool_state / verification_summary / generated_by / verified_by /
 * history) pass through untouched (the snapshot REUSES the canonical business schemas, so the backfill's
 * writeEvent parseEvent barrier validates them as ground truth). Dates stay Date (GenesisExperimental's
 * z.coerce.date() accepts both Date and the jsonb ISO string). The array columns default to [] at the
 * table, so they are always present.
 */
export function artifactRowToSnapshot(row: typeof artifact.$inferSelect): ArtifactRowSnapshotT {
  return pickArtifactFields(row, {
    knowledge_ids: row.knowledge_ids ?? [],
    attrs: row.attrs ?? {},
    history: row.history ?? [],
  });
}

/**
 * Gather the events affecting `artifactId` and run the pure artifact fold. Every artifact
 * event keys on the artifact id, so this is a single subject-keyed query. Returns the
 * projected row or null.
 */
export async function gatherAndFoldArtifact(
  db: DbLike,
  artifactId: string,
): Promise<ArtifactRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'artifact'), eq(event.subject_id, artifactId)));
  const foldEvents = rows.map(rowToFoldEvent);
  return foldArtifact(artifactId, foldEvents);
}

// An artifact is event-sourced when it has a create/genesis base event or an index anchor.
// Both base events are subject-keyed, so the event leg is complete.
const ARTIFACT_ANCHOR_ACTIONS = ['experimental:genesis', 'experimental:artifact_create'] as const;

/** Whether an artifact has an anchor the fold can reproduce. */
export async function hasArtifactGenesisAnchor(db: DbLike, artifactId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'artifact'),
        eq(event.subject_id, artifactId),
        inArray(event.action, [...ARTIFACT_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, artifactId),
        eq(materialized_id_index.subject_kind, 'artifact'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/** Batch form; also serves as the backfill's idempotency pre-scan. */
export async function artifactsWithGenesisAnchor(
  db: DbLike,
  artifactIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (artifactIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'artifact'),
        inArray(event.subject_id, artifactIds),
        inArray(event.action, [...ARTIFACT_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, artifactIds),
        eq(materialized_id_index.subject_kind, 'artifact'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

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
  const values = pickArtifactFields(projected, projected) as typeof artifact.$inferInsert;
  const { id: _id, ...set } = values;
  await db
    .insert(artifact)
    .values(values)
    .onConflictDoUpdate({
      target: artifact.id,
      set: set as Partial<typeof artifact.$inferInsert>,
    });
}
