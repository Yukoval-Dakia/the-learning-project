// YUK-1571 — shared read model over the `artifact_block_ref` backlink index,
// moved verbatim from the read half of src/capabilities/notes/server/block-refs.ts.
// The write-through index owner (syncBlockRefsForArtifact / desiredCrossLinkRefs)
// stays in notes/server/block-refs.ts.
//
// Source of truth for cross-links is L3: the flat `crossLinkBlock` node attrs
// inside an artifact's `body_blocks` (ADR-0022 — `attrs = { id, artifact_id,
// block_id?, title? }`, NOT nested under `attrs.cross_link`).
//
// XC-3: cross_link refs live in artifact_block_ref (L2) + block.attrs (L3, flat).
// NEVER store note refs in knowledge_edge (that's concept relations only).

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact, artifact_block_ref, learning_item } from '@/db/schema';

type DbLike = Db | Tx;

export interface BacklinkRow {
  from_artifact_id: string;
  from_block_id: string;
  from_artifact_title: string;
  from_artifact_type: string;
  to_artifact_id: string;
  to_block_id: string | null;
  ref_kind: string;
}

export interface BacklinksByArtifactType<T extends { from_type: string }> {
  [from_type: string]: T[];
}

export function groupBacklinksByArtifactType<T extends { from_type: string }>(
  rows: T[],
): BacklinksByArtifactType<T> {
  const grouped: BacklinksByArtifactType<T> = {};
  for (const row of rows) {
    grouped[row.from_type] = grouped[row.from_type] ?? [];
    grouped[row.from_type].push(row);
  }
  return grouped;
}

/**
 * Inbound refs pointing at `toArtifactId` (optionally narrowed to a specific
 * `toBlockId`), joined to the source `artifact` row for title + type. Reads via
 * the `artifact_block_ref_to_idx` (to_artifact_id [, to_block_id]).
 *
 * Returns every inbound ref regardless of `ref_kind` — callers (the Lane-B
 * backlink panel, the P6 node page) can filter on `ref_kind` if they only want
 * cross_link backlinks vs embedded_check quiz refs.
 */
export async function listBacklinks(
  db: DbLike,
  params: { toArtifactId: string; toBlockId?: string | null },
): Promise<BacklinkRow[]> {
  const conditions = [eq(artifact_block_ref.to_artifact_id, params.toArtifactId)];
  if (params.toBlockId != null) {
    conditions.push(eq(artifact_block_ref.to_block_id, params.toBlockId));
  }

  const rows = await db
    .select({
      from_artifact_id: artifact_block_ref.from_artifact_id,
      from_block_id: artifact_block_ref.from_block_id,
      from_artifact_title: artifact.title,
      from_artifact_type: artifact.type,
      to_artifact_id: artifact_block_ref.to_artifact_id,
      to_block_id: artifact_block_ref.to_block_id,
      ref_kind: artifact_block_ref.ref_kind,
    })
    .from(artifact_block_ref)
    .innerJoin(artifact, eq(artifact.id, artifact_block_ref.from_artifact_id))
    .where(and(...conditions));

  return rows.map((row) => ({
    from_artifact_id: row.from_artifact_id,
    from_block_id: row.from_block_id,
    from_artifact_title: row.from_artifact_title,
    from_artifact_type: row.from_artifact_type,
    to_artifact_id: row.to_artifact_id,
    to_block_id: row.to_block_id,
    ref_kind: row.ref_kind,
  }));
}

/**
 * Resolve a representative owning `learning_item.id` for a set of source artifact
 * ids via the `learning_item.primary_artifact_id` reference, returning
 * `artifact_id → learning_item.id` (see the ADR-0027 note below — this is now a
 * representative, not a 1:1 owner).
 *
 * Both backlink panels (the Lane-B artifact panel route + the P6 node page)
 * render a source artifact's row as a link to `/learning-items/<learning_item_id>`
 * — that route queries by `learning_item.id`, NOT `artifact.id`, so linking by the
 * raw `from_artifact_id` 404s (Codex #193 / YUK-160). Callers map each
 * `from_artifact_id` through this resolver; a source with no entry renders as a
 * non-link. Archived learning_items are excluded so retired items don't surface
 * as live links; both panels share this single resolver to stay behaviourally
 * identical.
 *
 * Representative-owner resolver (ADR-0027 / YUK-203 P1): a learning_item now only
 * *references* an artifact via `primary_artifact_id`, and MORE THAN ONE non-archived
 * item may reference the same artifact (the YUK-171 1:1 unique index was dropped).
 * For the backlink panel + node page we link a source artifact to a single
 * representative owner: rows are ordered by `created_at, id` so the EARLIEST
 * referencing item deterministically wins. Multiplicity is now VALID and NOT warned.
 * Rendering all referencing items is a follow-up (see notesForItem, P1-PR2). It must
 * NOT throw — it serves read panels and must never 500.
 */
export async function resolveOwningLearningItemIds(
  db: DbLike,
  artifactIds: string[],
): Promise<Map<string, string>> {
  if (artifactIds.length === 0) return new Map();
  const rows = await db
    .select({ id: learning_item.id, primary_artifact_id: learning_item.primary_artifact_id })
    .from(learning_item)
    .where(
      and(
        inArray(learning_item.primary_artifact_id, artifactIds),
        isNull(learning_item.archived_at),
      ),
    )
    // Deterministic ordering: earliest-created (tie-broken by id) wins, so a
    // duplicate non-archived owner resolves stably instead of by arbitrary DB
    // row order.
    .orderBy(asc(learning_item.created_at), asc(learning_item.id));
  const map = new Map<string, string>();
  for (const row of rows) {
    const artifactId = row.primary_artifact_id;
    if (!artifactId || map.has(artifactId)) continue;
    // Earliest-created referencing item wins (deterministic representative).
    map.set(artifactId, row.id);
  }
  return map;
}
