// YUK-95 P5 Lane-C (Wave 7) — nightly hub auto-sync worker (ADR-0020 §9).
//
// For every `type='note_hub'` artifact, maintain its `AutoLinksContainer`
// auto-zone with curated cross_links to related atomic notes per the
// "iii-curated" mesh rules (see `src/server/knowledge/hub-mesh.ts`). This is the
// AI-maintained counterpart to Lane-A's manual cross_link picker.
//
// Scheduling (Wave 7 D5): runs at BJT 02:45, AFTER knowledge_edge_propose_nightly
// (02:30) so it sees the same-night fresh edges. The user is asleep, so we do NOT
// rely on the in-memory editing-session heartbeat (that lives in the Next app
// process, not this worker process). Concurrency is handled purely by
// `persistNoteRefineApply`'s optimistic version lock: a concurrent user edit just
// makes the nightly apply a no-op via version conflict, and we retry next night.
//
// WRITE boundary (XC-3): the worker READS knowledge_edge (the mesh) to decide
// what to link, but WRITES only body_blocks (one replace_block / append_block on
// the AutoLinksContainer). The L2 artifact_block_ref index is kept in sync
// automatically by `syncBlockRefsForArtifact`, which runs inside
// `persistNoteRefineApply` (Lane-0) — this worker never touches the index or
// knowledge_edge directly.
//
// Idempotency: the desired children set is diffed against the current container
// children; when nothing changed we emit NO patch and NO event, so a second run
// over an unchanged mesh is a true no-op.
//
// ── ADR-0022 attr extension note (deviation, documented in the Lane-C report) ──
// crossLinkBlock per ADR-0022 carries flat `attrs = { id, artifact_id, block_id?,
// title? }`. Auto-links add two provenance attrs: `auto: true` (marks the link as
// system-maintained vs user-inserted) and `relation: <HubMeshRelation>` (so
// Lane-D renders the "via 子主题 / via prerequisite / via 派生 / via 对比" chip).
// These are additive flat attrs on the same node; they do not change the L2
// index shape (block-refs.ts reads only id / artifact_id / block_id). The
// TipTap node already passes `attrs` through (passthrough schema), so no node
// schema change is required.

import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { NotePatchT } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { persistNoteRefineApply } from '@/server/artifacts/note-refine-apply';
import { listKnowledgeEdges } from '@/server/knowledge/edges';
import {
  type CuratedAtomic,
  type HubMeshAtomicInput,
  type HubMeshEdge,
  resolveHubMeshAtomics,
} from '@/server/knowledge/hub-mesh';
import { type KnowledgeNode, loadTreeSnapshot } from '@/server/knowledge/tree';

const HUB_TYPE = 'note_hub';
const ATOMIC_TYPE = 'note_atomic';
const AUTO_LINKS_CONTAINER_NODE = 'autoLinksContainer';
const CROSS_LINK_BLOCK_NODE = 'crossLinkBlock';
const ACTOR_REF = 'hub_auto_sync';

interface HubRow {
  id: string;
  knowledge_ids: string[];
  body_blocks: unknown;
  attrs: Record<string, unknown> | null;
}

interface AtomicRow {
  id: string;
  title: string;
  knowledge_ids: string[];
}

export interface HubAutoSyncResult {
  hubs_considered: number;
  hubs_updated: number;
  hubs_skipped_version_conflict: number;
  cross_links_total: number;
}

export interface HubAutoSyncDeps {
  /** Inject pre-loaded snapshots for unit-style overrides; defaults load from db. */
  loadNodes?: (db: Db) => Promise<KnowledgeNode[]>;
  loadEdges?: (db: Db) => Promise<HubMeshEdge[]>;
  now?: Date;
}

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
// not a content change). Two sets are equal when the same crossLinkBlock
// (artifact_id + relation + title) appears in both, regardless of position.
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
 *
 * Pure given the parsed doc + curated atomics — split out so the diff logic is
 * directly testable.
 */
export function buildAutoZonePatch(
  bodyBlocks: unknown,
  hubArtifactId: string,
  curated: CuratedAtomic[],
): NotePatchT | null {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return null;
  const content = parsed.data.content ?? [];

  // Find the existing AutoLinksContainer (top-level only — §9 auto-zone is a
  // single doc-root container after the manual zone).
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
    // No-op when the set is unchanged (order-insensitive: user reorders are kept).
    if (sameChildSet(currentChildren, desiredChildren)) return null;

    const existingAttrs = recordOrEmpty(existing.attrs);
    const replacement = {
      type: AUTO_LINKS_CONTAINER_NODE,
      attrs: { ...existingAttrs, id: containerId },
      content: desiredChildren,
    };
    return { ops: [{ kind: 'replace_block', target_block_id: containerId, block: replacement }] };
  }

  // No container yet. If there's nothing to add, do nothing (don't create an
  // empty container and churn an event).
  if (desiredChildren.length === 0) return null;

  const container = {
    type: AUTO_LINKS_CONTAINER_NODE,
    attrs: { id: containerId, title: 'Related' },
    content: desiredChildren,
  };
  // Append after the manual zone (§9: 自动区在手动区之后).
  return { ops: [{ kind: 'append_block', block: container }] };
}

async function loadHubs(db: Db): Promise<HubRow[]> {
  const rows = await db
    .select({
      id: artifact.id,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      attrs: artifact.attrs,
    })
    .from(artifact)
    .where(and(eq(artifact.type, HUB_TYPE), isNull(artifact.archived_at)));
  return rows.map((r) => ({
    id: r.id,
    knowledge_ids: r.knowledge_ids ?? [],
    body_blocks: r.body_blocks,
    attrs: (r.attrs as Record<string, unknown> | null) ?? null,
  }));
}

async function loadAtomics(db: Db): Promise<AtomicRow[]> {
  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
    })
    .from(artifact)
    .where(and(eq(artifact.type, ATOMIC_TYPE), isNull(artifact.archived_at)));
  return rows.map((r) => ({ id: r.id, title: r.title, knowledge_ids: r.knowledge_ids ?? [] }));
}

async function defaultLoadEdges(db: Db): Promise<HubMeshEdge[]> {
  // Non-archived edges only (listKnowledgeEdges defaults includeArchived:false).
  const rows = await listKnowledgeEdges(db);
  return rows.map((r) => ({
    from_knowledge_id: r.from_knowledge_id,
    to_knowledge_id: r.to_knowledge_id,
    relation_type: r.relation_type,
  }));
}

/**
 * Scan every hub, recompute its curated auto-zone, and apply a single
 * replace_block / append_block patch when (and only when) it changed.
 *
 * 0 hubs → no-op. Per-hub failures inside `persistNoteRefineApply` surface as
 * statuses (version_conflict / not_found / archived) rather than throwing, so one
 * bad hub doesn't abort the batch.
 */
export async function runHubAutoSyncNightly(
  db: Db,
  deps: HubAutoSyncDeps = {},
): Promise<HubAutoSyncResult> {
  const hubs = await loadHubs(db);
  const result: HubAutoSyncResult = {
    hubs_considered: hubs.length,
    hubs_updated: 0,
    hubs_skipped_version_conflict: 0,
    cross_links_total: 0,
  };
  if (hubs.length === 0) return result;

  const nodes = await (deps.loadNodes ?? loadTreeSnapshot)(db);
  const edges = await (deps.loadEdges ?? defaultLoadEdges)(db);
  const atomics = await loadAtomics(db);

  const atomicInputs: HubMeshAtomicInput[] = atomics.map((a) => ({
    artifact_id: a.id,
    title: a.title,
    knowledge_ids: a.knowledge_ids,
  }));

  for (const hub of hubs) {
    const suppressed = suppressedArtifactIds(hub.attrs);
    const curated = resolveHubMeshAtomics(
      nodes,
      edges,
      { hub_artifact_id: hub.id, knowledge_ids: hub.knowledge_ids },
      atomicInputs,
    ).filter((c) => !suppressed.has(c.artifact_id));

    result.cross_links_total += curated.length;

    const patch = buildAutoZonePatch(hub.body_blocks, hub.id, curated);
    if (!patch) continue;

    const applied = await persistNoteRefineApply({
      db,
      artifactId: hub.id,
      patch,
      actorRef: ACTOR_REF,
      now: deps.now,
    });

    if (applied.status === 'applied') result.hubs_updated += 1;
    else if (applied.status === 'skipped:version_conflict') {
      result.hubs_skipped_version_conflict += 1;
    }
  }

  return result;
}

export function buildHubAutoSyncNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runHubAutoSyncNightly(db);
      console.log('[hub_auto_sync_nightly] result', result);
    } catch (err) {
      console.error('[hub_auto_sync_nightly] failed', err);
      throw err;
    }
  };
}
