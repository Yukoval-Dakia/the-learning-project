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

import type {
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  gatherAndFoldGoal,
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
  gatherAndFoldMistakeVariant,
} from './gather';
import { diffSnapshots } from './snapshot-diff';

type DbLike = Db | Tx;

/** Which fold the mismatch came from (for the structured warn / thrown message). */
type ParitySubjectKind =
  | 'knowledge'
  | 'knowledge_edge'
  | 'goal'
  | 'mistake_variant'
  | 'learning_item';

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

// ── goal parity assert (YUK-471 Wave 2) ──────────────────────────────────────────────────────
//
// The write-time fold==row guard for the goal imperative sites (accept / goal-create / retract /
// status / scope), mirroring assertKnowledgeNodeParity. After an OFF-path imperative write, the
// site re-selects the row → maps to GoalRowSnapshot → calls this, which gather→folds the SAME id
// read-only and deep-compares. dev/test THROW on mismatch, prod warn+return (the shared
// onParityMismatch switch). This is the "real teeth" that catches a reducer/wiring drift the
// moment it happens — goal establishes the pattern mistake_variant + learning_item inherit.
//
// APPLICABILITY GATE (mirror assertAcceptParity): the CALLER must only invoke this for a goal
// that is EVENT-SOURCED (hasGoalGenesisAnchor) — a pre-event-sourced goal folds to null and would
// FALSE-mismatch its live row. The wired sites always anchor the goal this tx (accept writes the
// proposal index anchor; goal-create writes a genesis), so they always assert; the no-live-caller
// status/scope helpers gate on hasGoalGenesisAnchor.

/**
 * Pick the GoalRowSnapshot fields from a live `goal` DB row (NO Zod parse — a .parse() throw on
 * the hot path could abort a live write in prod, defeating the never-throw contract). goal has no
 * derived columns, so the full row IS the snapshot.
 */
export function goalLiveRowToSnapshot(row: {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[] | null;
  sequence_hint: number;
  status: 'active' | 'dormant' | 'done';
  source: string;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}): GoalRowSnapshotT {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
    sequence_hint: row.sequence_hint,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Assert the goal fold reproduces the live `goal` row passed in. READ-ONLY gather→fold; dev/test
 * THROW on mismatch, prod warn+return (file header contract). A null live row that folds to null
 * passes. The gather is try-wrapped the SAME way as the node/edge asserts so an unanticipated
 * reducer throw never aborts a live write in prod.
 *
 * @param db       Db or Tx — pass the SAME tx the write happened in so the gather sees the
 *                 just-written row + events.
 * @param goalId   the goal id to re-project.
 * @param liveRow  the structural snapshot of the row the imperative path just wrote (or null), in
 *                 GoalRowSnapshot shape.
 */
export async function assertGoalParity(
  db: DbLike,
  goalId: string,
  liveRow: GoalRowSnapshotT | null,
): Promise<void> {
  let folded: GoalRowSnapshotT | null;
  try {
    folded = await gatherAndFoldGoal(db, goalId);
  } catch (err) {
    onParityMismatch('goal', goalId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('goal', goalId, diff);
}

// ── mistake_variant genesis-anchor helpers (YUK-471 Wave 2) ──────────────────────────────────
//
// A mistake_variant is EVENT-SOURCED (reproducible by foldMistakeVariant, so its fold-null is a
// genuine "should not exist" rather than a fold-blind miss) iff it has any of:
//   1. an `experimental:mistake_variant_create` runtime base event (post-W2 creation), OR
//   2. an `experimental:genesis` backfill seed (pre-W2 row), OR
//   3. a `materialized_id_index` row keyed by mvId with subject_kind='mistake_variant' (the
//      backfill/creation anchor).
// Both base events have subject_id = mvId (createId()-preallocated, no minting indirection), so the
// event check is a single subject-keyed scan over the two base actions.

const MISTAKE_VARIANT_ANCHOR_ACTIONS = [
  'experimental:mistake_variant_create',
  'experimental:genesis',
] as const;

/**
 * Does this `mistake_variant` have a base/genesis anchor — i.e. is it event-sourced (reproducible
 * by foldMistakeVariant) at all? READ-ONLY. Used by the guarded write-through (a fold-null on a
 * NON-event-sourced variant must NOT delete the imperative row) — mirrors hasGoalGenesisAnchor.
 */
export async function hasMistakeVariantGenesisAnchor(db: DbLike, mvId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'mistake_variant'),
        eq(event.subject_id, mvId),
        inArray(event.action, [...MISTAKE_VARIANT_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, mvId),
        eq(materialized_id_index.subject_kind, 'mistake_variant'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/**
 * Batch form of hasMistakeVariantGenesisAnchor — the subset of `mvIds` that ARE event-sourced. One
 * query per source (events / index). READ-ONLY. Used by the backfill to SKIP variants that already
 * re-fold from their own log (anchoring an already-event-sourced row with a current-state genesis
 * snapshot would mask reducer drift — same rationale as goalsWithGenesisAnchor). DOUBLES as the
 * backfill idempotency pre-scan (a previously-backfilled variant now carries a genesis event, and a
 * runtime-created variant carries a create event → both skipped).
 */
export async function mistakeVariantsWithGenesisAnchor(
  db: DbLike,
  mvIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (mvIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'mistake_variant'),
        inArray(event.subject_id, mvIds),
        inArray(event.action, [...MISTAKE_VARIANT_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, mvIds),
        eq(materialized_id_index.subject_kind, 'mistake_variant'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

// ── mistake_variant parity assert (YUK-471 Wave 2) ───────────────────────────────────────────
//
// The write-time fold==row guard for the mistake_variant imperative sites (creation / accept /
// verify / dismiss / retract), mirroring assertGoalParity. After an OFF-path imperative write, the
// site re-selects the row → maps to MistakeVariantRowSnapshot → calls this, which gather→folds the
// SAME id read-only and deep-compares. dev/test THROW on mismatch, prod warn+return (the shared
// onParityMismatch switch). This is the "real teeth" that catches a reducer/wiring drift the moment
// it happens — especially the fold-blind cause_category (the base event must carry it).
//
// APPLICABILITY GATE: the CALLER must only invoke this for a mistake_variant that is EVENT-SOURCED
// (hasMistakeVariantGenesisAnchor) — a pre-event-sourced row folds to null and would FALSE-mismatch
// its live row. The wired sites always anchor the variant this tx (creation writes the create event
// + index; accept/verify/dismiss/retract operate on an already-anchored row), so they always assert.

/**
 * Pick the MistakeVariantRowSnapshot fields from a live `mistake_variant` DB row (NO Zod parse — a
 * .parse() throw on the hot path could abort a live write in prod, defeating the never-throw
 * contract). The row has no derived/version columns, so the full row IS the snapshot.
 */
export function mistakeVariantLiveRowToSnapshot(row: {
  id: string;
  parent_question_id: string;
  variant_question_id: string | null;
  proposal_event_id: string | null;
  status: string;
  failure_reasons: string[] | null;
  cause_category: string | null;
  created_at: Date;
  updated_at: Date;
}): MistakeVariantRowSnapshotT {
  return {
    id: row.id,
    parent_question_id: row.parent_question_id,
    variant_question_id: row.variant_question_id,
    proposal_event_id: row.proposal_event_id,
    // status is a free `text` column on the table; narrow to the snapshot enum (the wired writers
    // only ever set draft|active|broken|dismissed, so the cast holds — a plain field-pick cannot
    // throw, unlike a Zod .parse() on the hot path).
    status: row.status as MistakeVariantRowSnapshotT['status'],
    failure_reasons: row.failure_reasons ?? [],
    cause_category: row.cause_category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Assert the mistake_variant fold reproduces the live row passed in. READ-ONLY gather→fold; dev/test
 * THROW on mismatch, prod warn+return (file header contract). A null live row that folds to null
 * passes. The gather is try-wrapped the SAME way as the goal/node/edge asserts so an unanticipated
 * reducer throw never aborts a live write in prod.
 *
 * @param mvId    the mistake_variant id to re-project.
 * @param liveRow the structural snapshot of the row the imperative path just wrote (or null), in
 *                MistakeVariantRowSnapshot shape.
 */
export async function assertMistakeVariantParity(
  db: DbLike,
  mvId: string,
  liveRow: MistakeVariantRowSnapshotT | null,
): Promise<void> {
  let folded: MistakeVariantRowSnapshotT | null;
  try {
    folded = await gatherAndFoldMistakeVariant(db, mvId);
  } catch (err) {
    onParityMismatch('mistake_variant', mvId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('mistake_variant', mvId, diff);
}

// ── learning_item genesis-anchor helpers (YUK-471 Wave 2) ────────────────────────────────────
//
// A learning_item is EVENT-SOURCED (reproducible by foldLearningItem, so its fold-null is a genuine
// "should not exist" rather than a fold-blind miss) iff it has any of:
//   1. an `experimental:genesis` seed (backfilled pre-W2 row, OR the per-id genesis written at the
//      learning_intent / ai_dream INSERT sites under the recommended route), OR
//   2. a `materialized_id_index` row keyed by itemId with subject_kind='learning_item' (the
//      genesis/creation anchor).
// (The W2 complete/relearn/archive action events are NOT anchors on their own — they mutate an
// already-seeded row; a row with ONLY a mutation event but no genesis base would fold to null, so
// the genesis/index anchor is the real "event-sourced" predicate.) The genesis subject_id = itemId
// (no minting indirection), so the event check is a single subject-keyed scan over the genesis action.

const LEARNING_ITEM_ANCHOR_ACTIONS = ['experimental:genesis'] as const;

/**
 * Does this `learning_item` have a genesis anchor — i.e. is it event-sourced (reproducible by
 * foldLearningItem) at all? READ-ONLY. Used by the guarded write-through (a fold-null on a
 * NON-event-sourced item must NOT delete the imperative row) — mirrors hasGoalGenesisAnchor.
 */
export async function hasLearningItemGenesisAnchor(db: DbLike, itemId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'learning_item'),
        eq(event.subject_id, itemId),
        inArray(event.action, [...LEARNING_ITEM_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, itemId),
        eq(materialized_id_index.subject_kind, 'learning_item'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/**
 * Batch form of hasLearningItemGenesisAnchor — the subset of `itemIds` that ARE event-sourced. One
 * query per source (events / index). READ-ONLY. Used by the backfill to SKIP items that already
 * re-fold from their own log (anchoring an already-event-sourced row with a current-state genesis
 * snapshot would mask reducer drift — same rationale as goalsWithGenesisAnchor). DOUBLES as the
 * backfill idempotency pre-scan (a previously-backfilled item now carries a genesis event → skipped).
 */
export async function learningItemsWithGenesisAnchor(
  db: DbLike,
  itemIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (itemIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'learning_item'),
        inArray(event.subject_id, itemIds),
        inArray(event.action, [...LEARNING_ITEM_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, itemIds),
        eq(materialized_id_index.subject_kind, 'learning_item'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

// ── learning_item parity assert (YUK-471 Wave 2) ──────────────────────────────────────────────
//
// The write-time fold==row guard for the learning_item imperative sites (creation / complete /
// relearn / archive-retract), mirroring assertGoalParity. After an OFF-path imperative write, the
// site re-selects the row → maps to LearningItemRowSnapshot → calls this, which gather→folds the
// SAME id read-only and deep-compares. dev/test THROW on mismatch, prod warn+return (the shared
// onParityMismatch switch).
//
// APPLICABILITY GATE: the CALLER must only invoke this for a learning_item that is EVENT-SOURCED
// (hasLearningItemGenesisAnchor) — a pre-event-sourced row folds to null and would FALSE-mismatch
// its live row. The wired creation sites always anchor the item this tx (genesis + index), so they
// always assert; the complete/relearn/archive sites gate on hasLearningItemGenesisAnchor (an
// un-backfilled pre-W2 item carries no anchor and is skipped).
//
// EXCLUDED columns (child_learning_item_ids / ai_score / due_at / reviewed_at) are NOT in the
// snapshot the row-pick produces, so they never enter the deep-diff — a row differing ONLY in those
// columns folds clean.

/**
 * Pick the LearningItemRowSnapshot fields from a live `learning_item` DB row (NO Zod parse — a
 * .parse() throw on the hot path could abort a live write in prod, defeating the never-throw
 * contract). EXCLUDES child_learning_item_ids / ai_score / due_at / reviewed_at (not in the
 * snapshot). `status` is a free `text` column; the field-pick passes it through unchanged
 * (the snapshot's `status` is z.string(), so no narrowing is needed — a plain pick cannot throw).
 */
export function learningItemLiveRowToSnapshot(row: {
  id: string;
  source: string;
  source_ref: string | null;
  title: string;
  content: string;
  knowledge_ids: string[] | null;
  primary_artifact_id: string | null;
  parent_learning_item_id: string | null;
  status: string;
  user_pinned: boolean;
  completed_at: Date | null;
  dismissed_at: Date | null;
  archived_at: Date | null;
  archived_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}): LearningItemRowSnapshotT {
  return {
    id: row.id,
    source: row.source,
    source_ref: row.source_ref,
    title: row.title,
    content: row.content,
    knowledge_ids: row.knowledge_ids ?? [],
    primary_artifact_id: row.primary_artifact_id,
    parent_learning_item_id: row.parent_learning_item_id,
    status: row.status,
    user_pinned: row.user_pinned,
    completed_at: row.completed_at,
    dismissed_at: row.dismissed_at,
    archived_at: row.archived_at,
    archived_reason: row.archived_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Assert the learning_item fold reproduces the live row passed in. READ-ONLY gather→fold; dev/test
 * THROW on mismatch, prod warn+return (file header contract). A null live row that folds to null
 * passes. The gather is try-wrapped the SAME way as the goal/node/edge asserts so an unanticipated
 * reducer throw never aborts a live write in prod.
 *
 * @param itemId  the learning_item id to re-project.
 * @param liveRow the structural snapshot of the row the imperative path just wrote (or null), in
 *                LearningItemRowSnapshot shape.
 */
export async function assertLearningItemParity(
  db: DbLike,
  itemId: string,
  liveRow: LearningItemRowSnapshotT | null,
): Promise<void> {
  let folded: LearningItemRowSnapshotT | null;
  try {
    folded = await gatherAndFoldLearningItem(db, itemId);
  } catch (err) {
    onParityMismatch('learning_item', itemId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('learning_item', itemId, diff);
}
