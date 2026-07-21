// YUK-384 — neutral shared home for the hub auto-zone builder + suppression
// reader. Lifted out of jobs/hub_auto_sync_nightly.ts so BOTH the durable
// reconciler (server/hub-sync-reconciliation.ts) and the nightly job import from
// here without an ESM cycle (the nightly job now imports runHubSyncCycle from the
// reconciler, which used to import these from the job — the reverse edge).
//
// Pure given the parsed doc + curated atomics; no DB/IO. See ADR-0020 §9 for the
// AutoLinksContainer auto-zone contract and ADR-0022 for the crossLinkBlock attr
// extension (auto / relation provenance).

import type { CuratedAtomic } from '@/capabilities/knowledge/server/hub-mesh';
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
 * Read the hub's `attrs.suppressed_block_refs` — the list of `{ artifact_id }`
 * the user has dismissed from the auto-zone (ADR-0020 §9 dismiss). Returns the
 * set of suppressed target artifact_ids. Tolerant of legacy/partial shapes.
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
 * Build the desired `crossLinkBlock` child for one curated atomic. The block id
 * is deterministic (`<container_id>__<atomic_artifact_id>`) so reorder/idempotent
 * diffs are stable across runs. Provenance attrs (`auto`, `relation`) feed the
 * Lane-D chip.
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
 * Compute the NotePatch (0 or 1 op) that brings the hub's auto-zone in line with
 * the curated set. Returns `null` when no change is needed (idempotent no-op).
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
