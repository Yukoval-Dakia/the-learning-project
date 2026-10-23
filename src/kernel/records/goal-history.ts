// Goal structural history: gather and fold, identify base anchors, and materialize
// the complete row. Live snapshots and projection writes share one explicit field pick.

import { and, eq, inArray } from 'drizzle-orm';

import { foldGoal } from '@/core/projections/goal';
import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, goal, materialized_id_index } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type GoalStructure = Required<GoalRowSnapshotT>;

/**
 * Gather the events affecting `goalId` and run the pure goal fold. Goal ids are never
 * minted into a rate, so the gather is the subject-keyed events plus the chained
 * accept/retract events. Returns the projected row or null.
 */
export async function gatherAndFoldGoal(
  db: DbLike,
  goalId: string,
): Promise<GoalRowSnapshotT | null> {
  // Q1: subject-keyed events (genesis, the goal_scope proposal, status/scope updates).
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'goal'), eq(event.subject_id, goalId)));

  // The accept rate and retract correct target the proposal event, not the goal row.
  const gatheredIds = q1.map((r) => r.id);
  const byId = new Map<string, EventRow>();
  for (const r of q1) byId.set(r.id, r);
  if (gatheredIds.length > 0) {
    const chained = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(event.action, ['rate', 'correct']),
          inArray(event.caused_by_event_id, gatheredIds),
        ),
      );
    for (const r of chained) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldGoal(goalId, foldEvents);
}

// ── goal genesis-anchor helpers ────────────────────────────────────────────────────────────────
//
// A goal is event-sourced when it has a genesis seed, a goal_scope proposal, or an index
// anchor. Status/scope updates are deliberately not anchors: the fold applies them only to
// an existing row, so counting them would let the guarded writer delete a live goal and the
// backfill skip it.
const GOAL_ANCHOR_ACTIONS = ['experimental:genesis', 'experimental:proposal'] as const;

/** Whether a goal has an anchor the fold can reproduce. */
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

/** Batch form; also serves as the backfill's idempotency pre-scan. */
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

// Select only structural fields after each boundary applies its existing normalization.
function pickGoalStructure(row: GoalStructure): GoalStructure {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids,
    scope_mode: row.scope_mode,
    sequence_hint: row.sequence_hint,
    declared_stage: row.declared_stage,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/** Pick snapshot fields from a live goal row without Zod parsing. */
export function goalRowToSnapshot(row: {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[] | null;
  scope_mode: 'explicit' | 'subject_live';
  sequence_hint: number;
  declared_stage: 'middle_school' | 'high_school' | 'university' | 'custom' | null;
  status: 'active' | 'dormant' | 'done';
  source: string;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}): GoalRowSnapshotT {
  return pickGoalStructure({
    ...row,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
  });
}

/** Re-project one `goal`; a fold of null deletes the row, otherwise upsert. */
export async function projectGoal(db: DbLike, goalId: string): Promise<void> {
  const projected = await gatherAndFoldGoal(db, goalId);
  if (projected === null) {
    await db.delete(goal).where(eq(goal.id, goalId));
    return;
  }
  await upsertProjectedGoal(db, projected);
}

/**
 * Guarded write-through: a fold of null deletes only when the goal has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
 */
export async function projectGoalGuarded(db: DbLike, goalId: string): Promise<void> {
  const projected = await gatherAndFoldGoal(db, goalId);
  if (projected === null) {
    if (await hasGoalGenesisAnchor(db, goalId)) {
      await db.delete(goal).where(eq(goal.id, goalId));
    }
    // else: fold-blind pre-event-sourced goal — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedGoal(db, projected);
}

// Upsert the full goal row; there are no derived or excluded columns.
async function upsertProjectedGoal(db: DbLike, projected: GoalRowSnapshotT): Promise<void> {
  const values = pickGoalStructure({
    ...projected,
    // Legacy payloads default to 'explicit'; the ?? only satisfies the optional snapshot type.
    scope_mode: projected.scope_mode ?? 'explicit',
    // Legacy snapshots carry no declared_stage; the fold materializes NULL.
    declared_stage: projected.declared_stage ?? null,
  });
  const { id: _id, ...fields } = values;
  await db.insert(goal).values(values).onConflictDoUpdate({
    target: goal.id,
    set: fields,
  });
}
