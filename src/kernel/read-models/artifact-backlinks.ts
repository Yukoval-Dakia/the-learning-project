// Shared read model over artifact_block_ref. The write-through index stays in
// notes/server/block-refs.ts.
//
// Cross-links are authoritative in the flat crossLinkBlock attrs inside body_blocks
// (ADR-0022) and mirrored into artifact_block_ref for lookup. Never store note refs
// in knowledge_edge, which is concept relations only.

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
 * Inbound refs for an artifact (optionally one block), joined to the source row for
 * title and type. Returns every ref_kind; callers filter when they need one kind.
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
 * Representative owning learning_item per source artifact. More than one live item
 * may reference an artifact, so the earliest (created_at, id) wins; a source with
 * no owner renders non-linked. Archived items are excluded. Never throws on
 * multiplicity: this serves read panels and must not 500.
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
    // Earliest created (tie-broken by id) wins so duplicate owners resolve stably.
    .orderBy(asc(learning_item.created_at), asc(learning_item.id));
  const map = new Map<string, string>();
  for (const row of rows) {
    const artifactId = row.primary_artifact_id;
    if (!artifactId || map.has(artifactId)) continue;
    // Keep the first row per artifact (deterministic representative).
    map.set(artifactId, row.id);
  }
  return map;
}
