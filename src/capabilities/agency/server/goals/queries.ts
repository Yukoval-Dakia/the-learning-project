// YUK-143 / ADR-0025 — North-Star `goal` queries (Wave-9 core).
//
// Goal rows are materialized from an accepted `goal_scope` proposal (see
// accept.ts) — the evidence-first default (ADR-0025). Exception (YUK-472): the
// cold-start at-entry path (`api/goal-create.ts`) also calls `insertGoal`
// directly with `source='manual'`, so a day-one user can declare a goal + KC
// scope before any evidence exists. Both paths share this single write surface.
// This module is the single write/read surface for the `goal` table:
//   - insertGoal       — INSERT write path (used by the materializer + tx)
//   - updateGoalStatus — UPDATE: active | dormant | done transition
//   - updateGoalScope  — UPDATE: re-proposed scope / sequence / title (AI may
//                        re-scope as the user progresses, ND-2; still via accept)
//   - listActiveGoals  — read for the Coach goal strand (ND-5 additive input)

import { and, asc, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
// YUK-471 W2 — goal status/scope events make these transitions fold-visible. These helpers have
// NO live caller today, but per defer-flip-not-build the event path + write-through are wired now
// so the moment a caller appears the goal fold already models the transition. The per-entity flag
// projectionIsWriter('goal') gates ONLY who writes the ROW (projection write-through when ON,
// imperative UPDATE when OFF).
import { projectGoalGuarded } from '@/server/projections/goal';
// HIGH-2 — write-time fold==row guard on the OFF branch. Gated on hasGoalGenesisAnchor checked
// BEFORE the action event is written: only a goal that already has a base (genesis / proposal)
// folds to a row the update can apply onto; a pre-event-sourced goal would FALSE-mismatch (fold
// null vs live row), so it is correctly SKIPPED (mirrors W1's assertAcceptParity applicability gate).
import {
  assertGoalParity,
  goalLiveRowToSnapshot,
  hasGoalGenesisAnchor,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';

type DbLike = Db | Tx;

export type GoalStatus = 'active' | 'dormant' | 'done';

export interface InsertGoalInput {
  id: string;
  title: string;
  subject_id?: string | null;
  scope_knowledge_ids: string[];
  sequence_hint: number;
  status?: GoalStatus;
  source: string;
  source_ref?: string | null;
  now?: Date;
}

export interface ActiveGoal {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[];
  sequence_hint: number;
}

export async function insertGoal(db: DbLike, input: InsertGoalInput): Promise<string> {
  const now = input.now ?? new Date();
  await db.insert(goal).values({
    id: input.id,
    title: input.title,
    subject_id: input.subject_id ?? null,
    scope_knowledge_ids: input.scope_knowledge_ids,
    sequence_hint: input.sequence_hint,
    status: input.status ?? 'active',
    source: input.source,
    source_ref: input.source_ref ?? null,
    created_at: now,
    updated_at: now,
  });
  return input.id;
}

/**
 * Transition a goal's status. ND-4: status is qualitative (active / dormant /
 * done) — never a progress percentage. Optimistic-concurrency bump on version.
 */
export async function updateGoalStatus(
  db: DbLike,
  goalId: string,
  status: GoalStatus,
  now: Date = new Date(),
): Promise<void> {
  const existing = (
    await db.select({ version: goal.version }).from(goal).where(eq(goal.id, goalId)).limit(1)
  )[0];
  if (!existing) return;
  // HIGH-2 applicability gate — capture whether the goal already has a fold BASE (genesis /
  // proposal) BEFORE writing the action event (the status event itself is an anchor action, so
  // checking after would always read true even for a base-less goal whose fold is null).
  const wasEventSourced = await hasGoalGenesisAnchor(db, goalId);
  // A3 (OCR major) — wrap the event write + ROW write in ONE tx so they commit atomically. A
  // future caller passing a plain Db (not an outer tx) would otherwise persist the status event
  // and then, if the UPDATE / parity throws, be left with the event but no matching row → a
  // permanent fold!=row divergence. db.transaction() opens a savepoint when `db` is already a Tx.
  await db.transaction(async (tx) => {
    // YUK-499 — lock the goal row FOR UPDATE before the action event + ROW write so concurrent goal
    // writers serialize on this row. On the ON path projectGoalGuarded has no version-CAS, so without
    // the lock two ON-path projects could interleave between the event write and the upsert: the
    // later gather would miss the earlier (uncommitted) event → stale fold → live row drifts from
    // fold(all events). The lock makes the read→fold→write-through atomic per goal id. No-op cost on
    // the OFF path, which already holds the row through its version-CAS UPDATE below. Mirrors the
    // artifact ON-path lock in body-blocks-edit.ts.
    await tx.select({ id: goal.id }).from(goal).where(eq(goal.id, goalId)).for('update');
    // YUK-471 W2 — append the fold-visible status event FIRST so the goal fold reproduces the
    // transition (status→new, version+1). The reducer mirrors the imperative +1 below.
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'goal-status-update',
      action: 'experimental:goal_status_update',
      subject_kind: 'goal',
      subject_id: goalId,
      outcome: 'success',
      payload: { status },
      created_at: now,
    });
    // A2 (OCR blocker) — only let the projection WRITE the row when the goal was already
    // event-sourced BEFORE this status event. The status event is itself a goal anchor, so by now
    // hasGoalGenesisAnchor would read true even for a base-less goal — calling projectGoalGuarded
    // on one would fold null yet PASS its (now-defeated) anchor guard → DELETE the live row. Fall
    // back to the imperative UPDATE to preserve it (the imperative write stays the SoT until the
    // goal is genuinely event-sourced).
    if (projectionIsWriter('goal') && wasEventSourced) {
      await projectGoalGuarded(tx, goalId);
    } else {
      await tx
        .update(goal)
        .set({ status, updated_at: now, version: existing.version + 1 })
        .where(and(eq(goal.id, goalId), eq(goal.version, existing.version)));
      // HIGH-2 — re-select + assert, only when the goal had a base the fold can seed from.
      if (wasEventSourced) {
        const [written] = await tx.select().from(goal).where(eq(goal.id, goalId)).limit(1);
        await assertGoalParity(tx, goalId, written ? goalLiveRowToSnapshot(written) : null);
      }
    }
  });
}

/**
 * Re-scope a goal (title / scope_knowledge_ids / sequence_hint). Used when the
 * AI re-proposes scope after the user progresses (ND-2 — still routed through a
 * confirmed proposal, never a silent change). `source` / `subject_id` are
 * set-once provenance and intentionally not mutated here.
 */
export async function updateGoalScope(
  db: DbLike,
  goalId: string,
  patch: { title?: string; scope_knowledge_ids?: string[]; sequence_hint?: number },
  now: Date = new Date(),
): Promise<void> {
  const existing = (
    await db.select({ version: goal.version }).from(goal).where(eq(goal.id, goalId)).limit(1)
  )[0];
  if (!existing) return;
  // HIGH-2 applicability gate — capture base presence BEFORE writing the action event (see
  // updateGoalStatus).
  const wasEventSourced = await hasGoalGenesisAnchor(db, goalId);
  // A3 (OCR major) — wrap the event write + ROW write in ONE tx (atomic), mirroring
  // updateGoalStatus. db.transaction() is a savepoint when `db` is already a Tx.
  await db.transaction(async (tx) => {
    // YUK-499 — lock the goal row FOR UPDATE before the action event + ROW write (same rationale as
    // updateGoalStatus): the ON-path projectGoalGuarded has no version-CAS, so the lock serializes
    // concurrent goal writers and keeps the read→fold→write-through atomic per goal id. No-op cost on
    // the OFF path (already version-CAS guarded).
    await tx.select({ id: goal.id }).from(goal).where(eq(goal.id, goalId)).for('update');
    // YUK-471 W2 — append the fold-visible scope event FIRST. The payload carries ONLY the patch
    // fields (the .strict() schema rejects mutating set-once provenance like subject_id). The
    // reducer applies the same patch + version+1 the imperative UPDATE does below.
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'goal-scope-update',
      action: 'experimental:goal_scope_update',
      subject_kind: 'goal',
      subject_id: goalId,
      outcome: 'success',
      payload: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.scope_knowledge_ids !== undefined
          ? { scope_knowledge_ids: patch.scope_knowledge_ids }
          : {}),
        ...(patch.sequence_hint !== undefined ? { sequence_hint: patch.sequence_hint } : {}),
      },
      created_at: now,
    });
    // A2 (OCR blocker) — only let the projection WRITE the row when the goal was already
    // event-sourced BEFORE this scope event (see updateGoalStatus): the scope event is itself a
    // goal anchor, so projectGoalGuarded on a base-less goal would fold null, pass its
    // now-defeated anchor guard, and DELETE the live row. Fall back to the imperative UPDATE.
    if (projectionIsWriter('goal') && wasEventSourced) {
      await projectGoalGuarded(tx, goalId);
    } else {
      await tx
        .update(goal)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.scope_knowledge_ids !== undefined
            ? { scope_knowledge_ids: patch.scope_knowledge_ids }
            : {}),
          ...(patch.sequence_hint !== undefined ? { sequence_hint: patch.sequence_hint } : {}),
          updated_at: now,
          version: existing.version + 1,
        })
        .where(and(eq(goal.id, goalId), eq(goal.version, existing.version)));
      // HIGH-2 — re-select + assert, only when the goal had a base the fold can seed from.
      if (wasEventSourced) {
        const [written] = await tx.select().from(goal).where(eq(goal.id, goalId)).limit(1);
        await assertGoalParity(tx, goalId, written ? goalLiveRowToSnapshot(written) : null);
      }
    }
  });
}

/**
 * Active goals ordered by sequence_hint then created_at. Fed into the Coach
 * input so it can distribute the goal strand across them (round-robin + weakest
 * first per ADR-0025 §3 v0). This is a read-only ADD to the Coach signal set —
 * it does not touch the FSRS-due / review backbone (ND-5).
 */
export async function listActiveGoals(db: DbLike): Promise<ActiveGoal[]> {
  const rows = await db
    .select({
      id: goal.id,
      title: goal.title,
      subject_id: goal.subject_id,
      scope_knowledge_ids: goal.scope_knowledge_ids,
      sequence_hint: goal.sequence_hint,
    })
    .from(goal)
    .where(eq(goal.status, 'active'))
    .orderBy(asc(goal.sequence_hint), asc(goal.created_at));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subject_id: r.subject_id,
    scope_knowledge_ids: r.scope_knowledge_ids ?? [],
    sequence_hint: r.sequence_hint,
  }));
}
