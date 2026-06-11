// YUK-143 / ADR-0025 — North-Star `goal` queries (Wave-9 core).
//
// Goal rows are materialized from an accepted `goal_scope` proposal (see
// accept.ts); they are NOT user-INSERTed directly (evidence-first, ADR-0025).
// This module is the single write/read surface for the `goal` table:
//   - insertGoal       — INSERT write path (used by the materializer + tx)
//   - updateGoalStatus — UPDATE: active | dormant | done transition
//   - updateGoalScope  — UPDATE: re-proposed scope / sequence / title (AI may
//                        re-scope as the user progresses, ND-2; still via accept)
//   - listActiveGoals  — read for the Coach goal strand (ND-5 additive input)

import { and, asc, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';

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
  await db
    .update(goal)
    .set({ status, updated_at: now, version: existing.version + 1 })
    .where(and(eq(goal.id, goalId), eq(goal.version, existing.version)));
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
