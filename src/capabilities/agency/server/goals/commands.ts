import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { projectGoal, projectGoalGuarded } from '@/server/projections/goal';
import { assertGoalParity, goalLiveRowToSnapshot } from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import type { InsertGoalInput } from './queries';

type GoalDb = Db | Tx;

/**
 * The only row-writer seam for goal commands. Callers provide the desired row
 * and never need to know whether the deployment is still on the imperative
 * writer or has flipped to the projection writer.
 */
export async function materializeGoalRow(db: GoalDb, input: InsertGoalInput): Promise<void> {
  if (projectionIsWriter('goal')) {
    await projectGoal(db, input.id);
    return;
  }
  const now = input.now ?? new Date();
  await db.insert(goal).values({
    id: input.id,
    title: input.title,
    subject_id: input.subject_id ?? null,
    scope_knowledge_ids: input.scope_knowledge_ids,
    scope_mode: input.scope_mode ?? 'explicit',
    sequence_hint: input.sequence_hint,
    status: input.status ?? 'active',
    source: input.source,
    source_ref: input.source_ref ?? null,
    created_at: now,
    updated_at: now,
  });
  const [written] = await db.select().from(goal).where(eq(goal.id, input.id)).limit(1);
  await assertGoalParity(db, input.id, written ? goalLiveRowToSnapshot(written) : null);
}

export async function applyGoalStatusRow(
  db: GoalDb,
  goalId: string,
  status: InsertGoalInput['status'],
  now: Date,
  wasEventSourced: boolean,
  version: number,
): Promise<void> {
  if (projectionIsWriter('goal') && wasEventSourced) {
    await projectGoalGuarded(db, goalId);
    return;
  }
  await db
    .update(goal)
    .set({ status, updated_at: now, version: version + 1 })
    .where(and(eq(goal.id, goalId), eq(goal.version, version)));
  if (wasEventSourced) {
    const [written] = await db.select().from(goal).where(eq(goal.id, goalId)).limit(1);
    await assertGoalParity(db, goalId, written ? goalLiveRowToSnapshot(written) : null);
  }
}

export async function applyGoalScopeRow(
  db: GoalDb,
  goalId: string,
  patch: Partial<Pick<InsertGoalInput, 'title' | 'scope_knowledge_ids' | 'sequence_hint'>>,
  now: Date,
  wasEventSourced: boolean,
  version: number,
): Promise<void> {
  if (projectionIsWriter('goal') && wasEventSourced) {
    await projectGoalGuarded(db, goalId);
    return;
  }
  await db
    .update(goal)
    .set({ ...patch, updated_at: now, version: version + 1 })
    .where(and(eq(goal.id, goalId), eq(goal.version, version)));
  if (wasEventSourced) {
    const [written] = await db.select().from(goal).where(eq(goal.id, goalId)).limit(1);
    await assertGoalParity(db, goalId, written ? goalLiveRowToSnapshot(written) : null);
  }
}
