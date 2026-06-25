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
  // YUK-471 W2 — append the fold-visible status event FIRST so the goal fold reproduces the
  // transition (status→new, version+1). The reducer mirrors the imperative +1 below.
  await writeEvent(db, {
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
  if (projectionIsWriter('goal')) {
    await projectGoalGuarded(db, goalId);
  } else {
    await db
      .update(goal)
      .set({ status, updated_at: now, version: existing.version + 1 })
      .where(and(eq(goal.id, goalId), eq(goal.version, existing.version)));
  }
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
  // YUK-471 W2 — append the fold-visible scope event FIRST. The payload carries ONLY the patch
  // fields (the .strict() schema rejects mutating set-once provenance like subject_id). The
  // reducer applies the same patch + version+1 the imperative UPDATE does below.
  await writeEvent(db, {
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
  if (projectionIsWriter('goal')) {
    await projectGoalGuarded(db, goalId);
  } else {
    await db
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
  }
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
