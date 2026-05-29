// YUK-95 P5 Lane-D (Wave 7), ADR-0020 §9 — pure helpers for the hub auto-link
// dismiss write path. Extracted out of the route module because Next.js route
// files may only export route handlers (+ a few reserved fields), not arbitrary
// helpers; keeping them here also makes them unit/db-testable in isolation.

import type { NotePatchT } from '@/core/schema/note-patch';

export const AUTO_LINKS_CONTAINER_NODE = 'autoLinksContainer';
export const CROSS_LINK_BLOCK_NODE = 'crossLinkBlock';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Append `{ artifact_id }` to `attrs.suppressed_block_refs`, deduping on
 * artifact_id. Returns the new attrs object (caller writes it). Tolerant of
 * legacy/missing shapes.
 */
export function appendSuppressedRef(
  attrs: Record<string, unknown> | null | undefined,
  artifactId: string,
): { attrs: Record<string, unknown>; added: boolean } {
  const base = recordOrEmpty(attrs);
  const rawList = Array.isArray(base.suppressed_block_refs) ? base.suppressed_block_refs : [];
  const already = rawList.some((entry) => recordOrEmpty(entry).artifact_id === artifactId);
  if (already) {
    return { attrs: { ...base, suppressed_block_refs: rawList }, added: false };
  }
  return {
    attrs: { ...base, suppressed_block_refs: [...rawList, { artifact_id: artifactId }] },
    added: true,
  };
}

/**
 * Build a single `replace_block` patch that drops the auto crossLinkBlock whose
 * `attrs.artifact_id === suppressedArtifactId` from the doc-root
 * AutoLinksContainer. Returns null when there is no container or no matching
 * auto child (idempotent: the child is already gone, or this hub has no
 * auto-zone).
 */
export function buildRemoveAutoLinkPatch(
  bodyBlocks: unknown,
  suppressedArtifactId: string,
): NotePatchT | null {
  const doc = recordOrEmpty(bodyBlocks);
  const content = Array.isArray(doc.content) ? (doc.content as Record<string, unknown>[]) : [];
  const container = content.find((n) => recordOrEmpty(n).type === AUTO_LINKS_CONTAINER_NODE);
  if (!container) return null;

  const containerId = recordOrEmpty(container.attrs).id;
  if (typeof containerId !== 'string' || containerId.length === 0) return null;

  const children = Array.isArray(container.content)
    ? (container.content as Record<string, unknown>[])
    : [];
  const remaining = children.filter((child) => {
    const attrs = recordOrEmpty(child.attrs);
    const isAutoTarget =
      child.type === CROSS_LINK_BLOCK_NODE &&
      attrs.auto === true &&
      attrs.artifact_id === suppressedArtifactId;
    return !isAutoTarget;
  });
  // No matching auto child → nothing to remove.
  if (remaining.length === children.length) return null;

  const replacement = {
    type: AUTO_LINKS_CONTAINER_NODE,
    attrs: { ...recordOrEmpty(container.attrs), id: containerId },
    content: remaining,
  };
  return { ops: [{ kind: 'replace_block', target_block_id: containerId, block: replacement }] };
}
