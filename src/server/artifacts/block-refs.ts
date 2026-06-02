// YUK-95 P5 Lane-0 (Wave 7 D4) — single-owner write-through for the
// `artifact_block_ref` L2 backlink index.
//
// Source of truth for cross-links is L3: the flat `crossLinkBlock` node attrs
// inside an artifact's `body_blocks` (ADR-0022 — `attrs = { id, artifact_id,
// block_id?, title? }`, NOT nested under `attrs.cross_link`). This module keeps
// the L2 index in sync on every body_blocks write.
//
// Design (Wave 7 D4 + the locked ref_kind addition):
//   - `syncBlockRefsForArtifact` is the ONLY cross_link writer. It full-recomputes
//     the cross_link rows for one artifact: DELETE all `ref_kind='cross_link'`
//     rows for `from_artifact_id`, then INSERT the deduped desired set scanned
//     from the doc. This is scoped by `ref_kind` so the `embedded_check` quiz
//     rows owned by `embedded_check_generate.ts` are never touched.
//   - `listBacklinks` reads inbound refs via the `artifact_block_ref_to_idx`
//     and joins `artifact` for the source title/type. Powers the Lane-B backlink
//     panel + the P6 node page.
//
// XC-3: cross_link refs live in artifact_block_ref (L2) + block.attrs (L3, flat).
// NEVER store note refs in knowledge_edge (that's concept relations only).

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, artifact_block_ref, learning_item } from '@/db/schema';

const CROSS_LINK_BLOCK_TYPE = 'crossLinkBlock';
const CROSS_LINK_REF_KIND = 'cross_link';

type DbLike = Db | Tx;

interface DesiredRef {
  from_artifact_id: string;
  from_block_id: string;
  to_artifact_id: string;
  to_block_id: string | null;
  ref_kind: typeof CROSS_LINK_REF_KIND;
}

export interface BacklinkRow {
  from_artifact_id: string;
  from_block_id: string;
  from_artifact_title: string;
  from_artifact_type: string;
  to_artifact_id: string;
  to_block_id: string | null;
  ref_kind: string;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Dedupe key over the unique index columns (from, from_block, to, COALESCE(to_block,'')).
// Delimited by NUL (\x00) so no real id substring can collide across fields. The
// source uses the \x00 escape (not a literal NUL byte) to keep this file plain
// UTF-8 text and diffable; the runtime string is byte-identical to a literal NUL.
function dedupeKey(ref: DesiredRef): string {
  return `${ref.from_artifact_id}\x00${ref.from_block_id}\x00${ref.to_artifact_id}\x00${ref.to_block_id ?? ''}`;
}

/**
 * Recursively scan `bodyBlocks` for `crossLinkBlock` nodes and derive the
 * desired cross_link index rows for `fromArtifactId`. Mirrors the recursive
 * visitor in `body-blocks.ts` (`bodyBlocksToBlockSummaries`).
 *
 * Each crossLinkBlock contributes one desired row keyed on its OWN `attrs.id`
 * (the from_block_id) → `attrs.artifact_id` (to_artifact_id) [+ `attrs.block_id`
 * as to_block_id]. Skips a node when:
 *   - it has no `attrs.id` (can't anchor a from_block_id), or
 *   - it has no `attrs.artifact_id` (no target), or
 *   - the target is the artifact itself (self-ref).
 */
export function desiredCrossLinkRefs(fromArtifactId: string, bodyBlocks: unknown): DesiredRef[] {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return [];

  const out: DesiredRef[] = [];
  const seen = new Set<string>();

  const visit = (node: Record<string, unknown>) => {
    if (node.type === CROSS_LINK_BLOCK_TYPE) {
      const attrs = recordOrEmpty(node.attrs);
      const fromBlockId = typeof attrs.id === 'string' ? attrs.id : undefined;
      const toArtifactId = typeof attrs.artifact_id === 'string' ? attrs.artifact_id : undefined;
      const toBlockId = typeof attrs.block_id === 'string' ? attrs.block_id : null;

      if (fromBlockId && toArtifactId && toArtifactId !== fromArtifactId) {
        const ref: DesiredRef = {
          from_artifact_id: fromArtifactId,
          from_block_id: fromBlockId,
          to_artifact_id: toArtifactId,
          to_block_id: toBlockId,
          ref_kind: CROSS_LINK_REF_KIND,
        };
        const key = dedupeKey(ref);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(ref);
        }
      }
    }

    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) {
      if (child !== null && typeof child === 'object') visit(child as Record<string, unknown>);
    }
  };

  for (const node of parsed.data.content ?? []) visit(node);
  return out;
}

/**
 * Recompute the `ref_kind='cross_link'` rows for `fromArtifactId` from its
 * current `body_blocks`. MUST run inside the same transaction as the
 * body_blocks write so the index never lags the document.
 *
 * Full-recompute scoped to cross_link: deletes the artifact's cross_link rows,
 * then inserts the deduped desired set. Rows with other `ref_kind` values
 * (notably `embedded_check`) are left untouched.
 */
export async function syncBlockRefsForArtifact(
  tx: Tx,
  fromArtifactId: string,
  bodyBlocks: unknown,
): Promise<void> {
  const desired = desiredCrossLinkRefs(fromArtifactId, bodyBlocks);

  await tx
    .delete(artifact_block_ref)
    .where(
      and(
        eq(artifact_block_ref.from_artifact_id, fromArtifactId),
        eq(artifact_block_ref.ref_kind, CROSS_LINK_REF_KIND),
      ),
    );

  if (desired.length > 0) {
    await tx.insert(artifact_block_ref).values(desired);
  }
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
 * Resolve owning `learning_item.id` for a set of source artifact ids via the 1:1
 * `learning_item.primary_artifact_id` link, returning `artifact_id → learning_item.id`.
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
