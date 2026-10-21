// Hub auto-zone builder and suppression reader. Lives here so the reconciler and
// the nightly job can share it without an import cycle. Pure: no DB or IO.

import type { CuratedAtomic } from '@/capabilities/knowledge/public';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { NotePatchT } from '@/core/schema/note-patch';

const AUTO_LINKS_CONTAINER_NODE = 'autoLinksContainer';
const CROSS_LINK_BLOCK_NODE = 'crossLinkBlock';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Target artifact ids the user dismissed from the auto-zone. Tolerant of legacy
 * and partial shapes.
 */
export function suppressedArtifactIds(attrs: Record<string, unknown> | null): Set<string> {
  const raw = recordOrEmpty(attrs).suppressed_block_refs;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const entry of raw) {
    const artifactId = recordOrEmpty(entry).artifact_id;
    if (typeof artifactId === 'string' && artifactId.length > 0) out.add(artifactId);
  }
  return out;
}

/**
 * The deterministic block id (`<container>__<artifact>`) keeps diffs stable;
 * the auto/relation attrs carry provenance to the chip.
 */
function desiredChild(containerId: string, atomic: CuratedAtomic) {
  return {
    type: CROSS_LINK_BLOCK_NODE,
    attrs: {
      id: `${containerId}__${atomic.artifact_id}`,
      artifact_id: atomic.artifact_id,
      block_id: null,
      title: atomic.title,
      auto: true,
      relation: atomic.relation,
    },
  };
}

// Compare two child lists ignoring order (the user may reorder; reorder-only is
// not a content change).
function childSignature(child: Record<string, unknown>): string {
  const attrs = recordOrEmpty(child.attrs);
  return JSON.stringify({
    type: child.type,
    artifact_id: attrs.artifact_id ?? null,
    relation: attrs.relation ?? null,
    title: attrs.title ?? null,
    auto: attrs.auto ?? null,
  });
}

function sameChildSet(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) return false;
  const countA = new Map<string, number>();
  for (const child of a)
    countA.set(childSignature(child), (countA.get(childSignature(child)) ?? 0) + 1);
  for (const child of b) {
    const key = childSignature(child);
    const n = countA.get(key);
    if (!n) return false;
    countA.set(key, n - 1);
  }
  return [...countA.values()].every((n) => n === 0);
}

/**
 * The one-op patch that aligns the auto-zone with the curated set, or null when
 * it already matches.
 */
export function buildAutoZonePatch(
  bodyBlocks: unknown,
  hubArtifactId: string,
  curated: CuratedAtomic[],
): NotePatchT | null {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return null;
  const content = parsed.data.content ?? [];

  const existingIndex = content.findIndex((n) => n.type === AUTO_LINKS_CONTAINER_NODE);
  const existing = existingIndex >= 0 ? (content[existingIndex] as Record<string, unknown>) : null;

  const containerId =
    existing && typeof recordOrEmpty(existing.attrs).id === 'string'
      ? (recordOrEmpty(existing.attrs).id as string)
      : `${hubArtifactId}__auto_links`;

  const desiredChildren = curated.map((c) => desiredChild(containerId, c));

  if (existing) {
    const currentChildren = (Array.isArray(existing.content) ? existing.content : []).filter(
      (c): c is Record<string, unknown> => c !== null && typeof c === 'object',
    );
    if (sameChildSet(currentChildren, desiredChildren)) return null;

    const existingAttrs = recordOrEmpty(existing.attrs);
    const replacement = {
      type: AUTO_LINKS_CONTAINER_NODE,
      attrs: { ...existingAttrs, id: containerId },
      content: desiredChildren,
    };
    return { ops: [{ kind: 'replace_block', target_block_id: containerId, block: replacement }] };
  }

  if (desiredChildren.length === 0) return null;

  const container = {
    type: AUTO_LINKS_CONTAINER_NODE,
    attrs: { id: containerId, title: 'Related' },
    content: desiredChildren,
  };
  return { ops: [{ kind: 'append_block', block: container }] };
}

/**
 * Stamp the canonical id on an auto-links container whose attrs.id is missing or
 * malformed. Without it, the reconciler's replace targets a block it can never
 * match and retries forever. Returns the body unchanged when there is nothing to
 * heal.
 */
export function normalizeMalformedAutoZoneContainer(
  bodyBlocks: unknown,
  hubArtifactId: string,
): { bodyBlocks: unknown; healed: boolean } {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return { bodyBlocks, healed: false };
  const content = parsed.data.content ?? [];
  const idx = content.findIndex((n) => n.type === AUTO_LINKS_CONTAINER_NODE);
  if (idx < 0) return { bodyBlocks, healed: false };

  const container = content[idx] as Record<string, unknown>;
  const attrs = recordOrEmpty(container.attrs);
  if (typeof attrs.id === 'string') return { bodyBlocks, healed: false };

  const fallbackId = `${hubArtifactId}__auto_links`;
  const nextContent = content.map((node, i) =>
    i === idx
      ? { ...(node as Record<string, unknown>), attrs: { ...attrs, id: fallbackId } }
      : node,
  );
  return { bodyBlocks: { ...parsed.data, content: nextContent }, healed: true };
}
