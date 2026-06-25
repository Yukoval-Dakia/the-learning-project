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
// The deep-equal (diffSnapshots / normalize) lives in ./snapshot-diff and is SHARED with
// scripts/audit-projection.ts so the in-tx assert and the offline B3 audit agree byte-for-byte
// on what "fold == row" means. It is OBJECT-KEY-ORDER-INSENSITIVE (jsonb key-order from
// Postgres never reads as drift) but compares ARRAYS positionally — the one array field,
// knowledge.merged_from, is meaningfully ordered (merge history) and matches on both sides. A
// null live row + null fold both pass (a node/edge the fold says should not exist and the live
// path did not write is parity-OK).

import type { KnowledgeEdgeRowSnapshotT, KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { gatherAndFoldKnowledgeEdge, gatherAndFoldKnowledgeNode } from './gather';
import { diffSnapshots } from './snapshot-diff';

type DbLike = Db | Tx;

/** Which fold the mismatch came from (for the structured warn / thrown message). */
type ParitySubjectKind = 'knowledge' | 'knowledge_edge';

// onParityMismatch — the dev-throws / prod-logs severity switch (see the file header for the
// full contract). PROD: structured warn + return (never break a live accept). ELSE: throw.
function onParityMismatch(subjectKind: ParitySubjectKind, id: string, diff: string[]): void {
  const diffText = diff.join('; ');
  if (process.env.NODE_ENV === 'production') {
    // PROD: log only the diverged FIELD NAMES + count — NEVER the values. Each diff line is
    // "<col>: <live> → <folded>", so the prefix before the first ':' is the column (or a
    // '<row>' / '<fold-threw>' sentinel). Knowledge names, domains and edge reasoning are
    // user content and must not leak into prod logs; full per-value detail stays in the
    // dev/test thrown message and is recoverable offline via `pnpm audit:projection` against
    // a prod-clone (PR-B's B3 SoT-flip gate).
    console.warn('[projection-parity] fold != live row', {
      subject_kind: subjectKind,
      id,
      diff_fields: diff.map((line) => line.split(':', 1)[0] ?? line),
      diff_count: diff.length,
    });
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
    .where(
      and(
        eq(materialized_id_index.materialized_id, nodeId),
        // genesis anchor for a NODE — materialized_id_index also carries edge anchors, so
        // constrain by subject_kind to never read an edge anchor as a node's genesis anchor.
        eq(materialized_id_index.subject_kind, 'knowledge'),
      ),
    )
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
    .where(
      and(
        inArray(materialized_id_index.materialized_id, nodeIds),
        // NODE anchors only — see hasKnowledgeNodeGenesisAnchor (edge anchors share the table).
        eq(materialized_id_index.subject_kind, 'knowledge'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

// ── goal genesis-anchor helpers (YUK-471 Wave 2) ─────────────────────────────────────────────
//
// A goal is EVENT-SOURCED (reproducible by foldGoal, so its fold-null is a genuine "should not
// exist" rather than a fold-blind miss) iff it has any of:
//   1. an `experimental:genesis` seed (backfilled pre-W2 / event-less manual goal),
//   2. an `experimental:proposal` event with subject_kind='goal' subject_id=goalId (the
//      goal_scope proposal that materialized it — the proposal+accept chain folds it),
//   3. a W2 goal action event (`experimental:goal_status_update` / `experimental:goal_scope_update`),
//   4. a `materialized_id_index` row keyed by goalId with subject_kind='goal' (the backfill anchor).
// All of these have subject_id = goalId (no minting indirection), so the event check is a single
// subject-keyed scan over the action set.

const GOAL_ANCHOR_ACTIONS = [
  'experimental:genesis',
  'experimental:proposal',
  'experimental:goal_status_update',
  'experimental:goal_scope_update',
] as const;

/**
 * Does this `goal` have a genesis anchor / originating event chain — i.e. is it event-sourced
 * (reproducible by foldGoal) at all? READ-ONLY. Used by the guarded write-through (a fold-null
 * on a NON-event-sourced goal must NOT delete the imperative row) — mirrors
 * hasKnowledgeNodeGenesisAnchor.
 */
export async function hasGoalGenesisAnchor(db: DbLike, goalId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'goal'),
        eq(event.subject_id, goalId),
        inArray(event.action, [...GOAL_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, goalId),
        eq(materialized_id_index.subject_kind, 'goal'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/**
 * Batch form of hasGoalGenesisAnchor — the subset of `goalIds` that ARE event-sourced. One
 * query per source (events / index). READ-ONLY. Used by the backfill to SKIP goals that already
 * re-fold from their own log (anchoring them with a current-state genesis snapshot would mask
 * reducer drift — same rationale as knowledgeNodesWithGenesisAnchor). DOUBLES as the backfill
 * idempotency pre-scan (a previously-backfilled goal now carries a genesis event → skipped).
 */
export async function goalsWithGenesisAnchor(db: DbLike, goalIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (goalIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'goal'),
        inArray(event.subject_id, goalIds),
        inArray(event.action, [...GOAL_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, goalIds),
        eq(materialized_id_index.subject_kind, 'goal'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

/**
 * Assert the node fold reproduces the live `knowledge` row passed in. READ-ONLY gather→fold;
 * dev/test THROW on mismatch, prod warn+return (see file header). A null live row that folds
 * to null passes.
 *
 * The node gather is try-wrapped the SAME way as the edge assert: foldKnowledgeNode is a large
 * pure reducer that could throw on an unanticipated event shape (e.g. a TypeError), and the
 * gather runs AFTER the SoT write inside the accept tx — letting such a throw propagate would
 * roll back a successful accept, violating the contract "never break a live accept over a
 * fold/parity bug." Any gather throw is routed through the SAME dev-throws/prod-logs switch as
 * a mismatch (prod warn + return, dev/test rethrow). A genuine DB error already poisons the tx
 * so the commit fails regardless — the wrap only rescues the pure-reducer-throw case.
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
  let folded: KnowledgeRowSnapshotT | null;
  try {
    folded = await gatherAndFoldKnowledgeNode(db, nodeId);
  } catch (err) {
    // A reducer/gather throw (unanticipated event shape, etc.) must never abort the live
    // accept in prod — route it through the same switch as a mismatch (see the doc comment).
    onParityMismatch('knowledge', nodeId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
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
    // Tag a topology-reject distinctly from a generic reducer/gather throw: the fold re-runs
    // the ADR-0034 gate the imperative path skipped, so a throw here can mean a cyclic/invalid
    // edge was committed (a data-integrity gap) rather than a plain projection bug. In prod
    // both only warn, and they'd log identically without this tag — so an operator can't tell
    // them apart. (OCR #580.)
    const msg = err instanceof Error ? err.message : String(err);
    const isTopologyReject = /topology|cycle|prerequisite|direction/i.test(msg);
    onParityMismatch('knowledge_edge', edgeId, [
      `<fold-threw${isTopologyReject ? ':topology' : ''}>: ${msg}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('knowledge_edge', edgeId, diff);
}
