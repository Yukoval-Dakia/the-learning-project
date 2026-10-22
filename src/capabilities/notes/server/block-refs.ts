// Single-owner write-through for the `artifact_block_ref` backlink index. The
// source of truth is the flat crossLinkBlock attrs in body_blocks; this module
// keeps the index in sync on every write. Note refs never go into
// knowledge_edge, which holds concept relations only.
//
// The read side lives in the shared kernel read model; the re-exports below keep
// this file's compat surface.

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

// NUL-delimited so ids cannot collide across fields; written as an escape to
// keep the source plain text.
function dedupeKey(ref: DesiredRef): string {
  return `${ref.from_artifact_id}\x00${ref.from_block_id}\x00${ref.to_artifact_id}\x00${ref.to_block_id ?? ''}`;
}

/**
 * Derive the desired cross_link rows from the block tree. A node without an
 * anchor id, without a target, or pointing at itself contributes nothing.
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
 * Recompute this artifact's cross_link rows. Must run in the same transaction as
 * the body write so the index never lags it. Other ref_kinds are left alone.
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
