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
//
// YUK-1571 — the backlink READ side (listBacklinks / groupBacklinksByArtifactType /
// resolveOwningLearningItemIds) moved verbatim to
// @/kernel/read-models/artifact-backlinks (shared cross-capability read model);
// the re-export below keeps this file's compat surface for notes-internal
// consumers and notes/public.
//
// XC-3: cross_link refs live in artifact_block_ref (L2) + block.attrs (L3, flat).
// NEVER store note refs in knowledge_edge (that's concept relations only).

import { and, eq } from 'drizzle-orm';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { Tx } from '@/db/client';
import { artifact_block_ref } from '@/db/schema';

export type {
  BacklinkRow,
  BacklinksByArtifactType,
} from '@/kernel/read-models/artifact-backlinks';
export {
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/kernel/read-models/artifact-backlinks';

const CROSS_LINK_BLOCK_TYPE = 'crossLinkBlock';
const CROSS_LINK_REF_KIND = 'cross_link';

interface DesiredRef {
  from_artifact_id: string;
  from_block_id: string;
  to_artifact_id: string;
  to_block_id: string | null;
  ref_kind: typeof CROSS_LINK_REF_KIND;
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
