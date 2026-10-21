// Goal semantic command entrypoints. Creation and mutation rules live in
// commands.ts; the shared active-goal read model is
// @/kernel/read-models/active-goal-scope.

import type { DeclaredStageT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { type GoalStatus, mutateGoal } from './commands';

type DbLike = Db | Tx;

export type { GoalScopeMode, GoalStatus, InsertGoalInput } from './commands';

/**
 * Transition a goal's status. Status is qualitative (active / dormant / done) — never a
 * progress percentage.
 */
export async function updateGoalStatus(
  db: DbLike,
  goalId: string,
  status: GoalStatus,
  now: Date = new Date(),
): Promise<void> {
  await mutateGoal(db, goalId, { kind: 'status', status, actorRef: 'goal-status-update', now });
}

/**
 * Re-scope a goal (title / scope_knowledge_ids / sequence_hint / declared_stage). Used
 * when the AI re-proposes scope after the user progresses — still routed through a
 * confirmed proposal, never a silent change. `source` / `subject_id` are set-once
 * provenance and not mutated here. `declared_stage` is a curriculum constraint, never a
 * θ̂ input; explicit null clears the declaration.
 */
export async function updateGoalScope(
  db: DbLike,
  goalId: string,
  patch: {
    title?: string;
    scope_knowledge_ids?: string[];
    sequence_hint?: number;
    declared_stage?: DeclaredStageT | null;
    placement_starter_augmentation?: boolean;
  },
  now: Date = new Date(),
  actorRef = 'goal-scope-update',
): Promise<void> {
  // Lock/read/version capture must happen in the same transaction as the event and row write.
  // Reading `existing` before this boundary permits a concurrent owner update to be overwritten
  // by a stale replacement patch after the row lock is eventually acquired.
  await mutateGoal(db, goalId, { kind: 'scope', ...patch, actorRef, now });
}
