// YUK-471 W1 PR-A2b (DoubleWrite phase) — the accept-time projection PARITY ASSERT.
//
// PR-A2b makes the projection fold VERIFIABLE against the live row at accept time, so PR-B
// can flip the source-of-truth safely. The imperative write STAYS the SoT (no flip here).
// After each live accept site writes the row + its events, it calls one of these asserts:
// gather→fold the SAME id read-only (gatherAndFold*, which write NOTHING) and deep-compare
// the projected snapshot against the live row the imperative path just wrote IN THE SAME TX.
//
// WHY in-tx. The assert runs inside the accept tx AFTER the rate/generate write so the fold
// sees the chained accept (a node folded before its accepting rate is written would project
// stale/null). The FOR-UPDATE-serialized accept tx is the natural boundary; reading the
// just-written row + events back through the gather is what proves fold(events) == row.
//
// ── DEV-THROWS / PROD-LOGS CONTRACT ──────────────────────────────────────────────────────
// onParityMismatch is severity-switched on NODE_ENV:
//   - PRODUCTION (process.env.NODE_ENV === 'production') → console.warn (structured, tag
//     '[projection-parity]') and RETURN. We NEVER break a live accept over a fold/parity
//     bug: the imperative write already succeeded and is the SoT; a divergent fold is a
//     projection bug, not a reason to fail the user's accept. Accumulated drift is caught
//     BEFORE the SoT flip by `pnpm audit:projection` against a prod-clone (PR-B's B3 gate).
//   - DEV / TEST (anything else) → THROW. Tests and local dev must surface a fold↔row
//     divergence immediately (a silently-passing mismatch in CI would let a real reducer
//     bug land), so the assert is a hard gate everywhere except prod.
//
// The deep-equal is ORDER-INSENSITIVE: Dates compared by getTime(), object keys sorted
// before stringify — mirrors scripts/audit-projection.ts normalize() so a jsonb key-order
// difference (created_by coming back from Postgres in a different key order) never reads as
// a spurious mismatch. A null live row + null fold both pass (a node/edge that the fold says
// should not exist and that the live path did not write is parity-OK).

import type { KnowledgeEdgeRowSnapshotT, KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { gatherAndFoldKnowledgeEdge, gatherAndFoldKnowledgeNode } from './gather';

type DbLike = Db | Tx;

/** Which fold the mismatch came from (for the structured warn / thrown message). */
type ParitySubjectKind = 'knowledge' | 'knowledge_edge';

// normalize — stable structural value for deep-equality. Dates → epoch ms; objects have
// their keys sorted so JSON.stringify is ORDER-INSENSITIVE (a jsonb object whose keys come
// back from Postgres in a different order than the fold built them must NOT read as a
// mismatch). Identical to scripts/audit-projection.ts normalize() so the in-tx assert and
// the standalone auditor agree on what "equal" means.
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = normalize(obj[k]);
    return out;
  }
  return value;
}

// diffSnapshots — field-by-field deep-diff; returns human-readable "col: live → folded"
// lines (empty array = parity). A null live with a non-null fold (or vice-versa) is a
// whole-row mismatch. Mirrors scripts/audit-projection.ts diffSnapshots().
function diffSnapshots(
  live: Record<string, unknown> | null,
  folded: Record<string, unknown> | null,
): string[] {
  if (live === null && folded === null) return [];
  if (live === null) return ['<row>: absent → fold-produced (live write missing a row)'];
  if (folded === null)
    return ['<row>: present → fold-null (live row not reproducible from events)'];
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(folded)]);
  for (const k of keys) {
    const a = JSON.stringify(normalize(live[k]));
    const b = JSON.stringify(normalize(folded[k]));
    if (a !== b) diffs.push(`${k}: ${a} → ${b}`);
  }
  return diffs;
}

// onParityMismatch — the dev-throws / prod-logs severity switch (see the file header for the
// full contract). PROD: structured warn + return (never break a live accept). ELSE: throw.
function onParityMismatch(subjectKind: ParitySubjectKind, id: string, diff: string[]): void {
  const diffText = diff.join('; ');
  if (process.env.NODE_ENV === 'production') {
    console.warn('[projection-parity] fold != live row', { subject_kind: subjectKind, id, diff });
    return;
  }
  throw new Error(
    `[projection-parity] ${subjectKind} ${id}: fold(events) != live row — ${diffText}`,
  );
}

/**
 * Pick the structural KnowledgeRowSnapshot fields from a live `knowledge` DB row (drops
 * embed_*; NO Zod parse/validation). Use this at the accept-time call sites instead of
 * `KnowledgeRowSnapshot.parse(row)`: a Zod `.parse()` on the hot path could THROW and abort a
 * live accept in prod, defeating the never-throw-on-the-hot-path contract this module upholds.
 * A plain field-pick cannot throw; the row came straight from the appliers so its types hold.
 */
export function knowledgeLiveRowToSnapshot(row: {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  merged_from: string[];
  archived_at: Date | null;
  proposed_by_ai: boolean;
  approval_status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  updated_at: Date;
  version: number;
}): KnowledgeRowSnapshotT {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    parent_id: row.parent_id,
    merged_from: row.merged_from,
    archived_at: row.archived_at,
    proposed_by_ai: row.proposed_by_ai,
    approval_status: row.approval_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Does this `knowledge` node have a GENESIS ANCHOR in the event log — i.e. is it
 * event-sourced (reproducible by the fold) at all? READ-ONLY.
 *
 * APPLICABILITY GATE for the accept-time parity assert. A node that PREDATES event-sourcing
 * (a seed root, a legacy pre-W1 row) was INSERTed directly and has no originating event, so
 * `gatherAndFoldKnowledgeNode` folds it to null — comparing fold(null) against the live row
 * would be a guaranteed FALSE mismatch, not a real divergence. (The PR-A2a genesis backfill
 * establishes those anchors later; until then audit:projection's allowlist covers them.)
 *
 * A node IS event-sourced iff at least one of:
 *   1. an `experimental:genesis` seed event with subject_id = nodeId (backfilled pre-W1 row),
 *   2. an `experimental:auto_tag_kc_created` event with subject_id = nodeId (auto-tag create),
 *   3. a `materialized_id_index` row keyed by nodeId (propose_new / split mint, post-keystone).
 * (A propose_new/split node has NO event with subject_id = nodeId — its only anchor is the
 * index row, which is why #3 is required.)
 *
 * Callers gate the parity assert on this: assert only when the node is event-sourced; a
 * non-event-sourced node is SKIPPED (its fold-vs-row mismatch is expected, not a bug).
 */
export async function hasKnowledgeNodeGenesisAnchor(db: DbLike, nodeId: string): Promise<boolean> {
  const genesisOrAutoTag = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge'),
        eq(event.subject_id, nodeId),
        or(
          eq(event.action, 'experimental:genesis'),
          eq(event.action, 'experimental:auto_tag_kc_created'),
        ),
      ),
    )
    .limit(1);
  if (genesisOrAutoTag.length > 0) return true;

  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(eq(materialized_id_index.materialized_id, nodeId))
    .limit(1);
  return indexed.length > 0;
}

/**
 * Batch form of hasKnowledgeNodeGenesisAnchor — returns the subset of `nodeIds` that ARE
 * event-sourced (have a genesis anchor). One query per source (events / index) instead of one
 * per id. READ-ONLY.
 */
export async function knowledgeNodesWithGenesisAnchor(
  db: DbLike,
  nodeIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (nodeIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge'),
        inArray(event.subject_id, nodeIds),
        or(
          eq(event.action, 'experimental:genesis'),
          eq(event.action, 'experimental:auto_tag_kc_created'),
        ),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(inArray(materialized_id_index.materialized_id, nodeIds));
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

/**
 * Assert the node fold reproduces the live `knowledge` row passed in. READ-ONLY gather→fold;
 * dev/test THROW on mismatch, prod warn+return (see file header). A null live row that folds
 * to null passes.
 *
 * Unlike the edge assert, the node gather is throw-free by construction (no topology gate;
 * malformed events warn+skip in the reducer), so it is NOT try-wrapped — an actual exception
 * here would be a DB/tx failure that SHOULD propagate, not a fold concern to swallow.
 *
 * @param db       Db or Tx — pass the SAME tx the accept wrote in so the gather sees the
 *                 just-written row + rate event.
 * @param nodeId   the knowledge id to re-project.
 * @param liveRow  the structural snapshot of the row the imperative path just wrote (or null
 *                 if the live path produced no row), in KnowledgeRowSnapshot shape.
 */
export async function assertKnowledgeNodeParity(
  db: DbLike,
  nodeId: string,
  liveRow: KnowledgeRowSnapshotT | null,
): Promise<void> {
  const folded = await gatherAndFoldKnowledgeNode(db, nodeId);
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('knowledge', nodeId, diff);
}

/**
 * Assert the edge fold reproduces the live `knowledge_edge` row passed in. READ-ONLY
 * gather→fold; dev/test THROW on mismatch, prod warn+return. A null live row that folds to
 * null passes.
 *
 * TOPOLOGY-REJECT SAFETY: gatherAndFoldKnowledgeEdge re-runs the ADR-0034 topology gate on a
 * live prerequisite create and may THROW on a cycle/direction reject. The IMPERATIVE edge
 * create path (actions.ts) does NOT run that gate, so a just-committed prerequisite edge that
 * the fold considers cyclic would make the gather throw. We must NOT let that abort the live
 * accept in production (same contract as a parity mismatch: the imperative write is the SoT;
 * a fold-side reject is a projection concern, not a reason to fail the user's accept). So the
 * gather is wrapped — any throw (topology reject or other gather failure) is routed through
 * the SAME dev-throws/prod-logs switch: prod → warn + return, dev/test → rethrow (surface it
 * loudly so the inconsistency is caught before the SoT flip).
 *
 * @param db       Db or Tx — pass the accept tx so the gather sees the just-written edge +
 *                 generate event.
 * @param edgeId   the knowledge_edge id to re-project.
 * @param liveRow  the structural snapshot of the edge row just written (or null), in
 *                 KnowledgeEdgeRowSnapshot shape.
 */
export async function assertKnowledgeEdgeParity(
  db: DbLike,
  edgeId: string,
  liveRow: KnowledgeEdgeRowSnapshotT | null,
): Promise<void> {
  let folded: KnowledgeEdgeRowSnapshotT | null;
  try {
    folded = await gatherAndFoldKnowledgeEdge(db, edgeId);
  } catch (err) {
    // A fold-side throw (ADR-0034 topology reject on a prerequisite the imperative path did
    // not gate, or any gather failure) must never break a live accept in prod. Route it
    // through the prod-logs / dev-throws switch as a whole-row mismatch.
    onParityMismatch('knowledge_edge', edgeId, [
      `<fold-threw>: ${(err as Error).message ?? String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('knowledge_edge', edgeId, diff);
}
