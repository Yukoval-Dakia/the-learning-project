import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { newId } from '@/core/ids';
import { writeEvent } from '@/kernel/events';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import { projectGoal, projectGoalGuarded } from '@/server/projections/goal';
import {
  assertGoalParity,
  goalLiveRowToSnapshot,
  hasGoalGenesisAnchor,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
type GoalDb = Db | Tx;

export type GoalStatus = 'active' | 'dormant' | 'done';
export type GoalScopeMode = 'explicit' | 'subject_live';
export interface InsertGoalInput {
  id: string;
  title: string;
  subject_id?: string | null;
  scope_knowledge_ids: string[];
  scope_mode?: GoalScopeMode;
  sequence_hint: number;
  status?: GoalStatus;
  source: string;
  source_ref?: string | null;
  now?: Date;
}

export async function mutateGoal(
  db: GoalDb,
  input: {
    goalId: string;
    action: 'status' | 'scope';
    payload: Record<string, unknown>;
    rowPatch: Record<string, unknown>;
    actorRef: string;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: goal.version })
      .from(goal)
      .where(eq(goal.id, input.goalId))
      .for('update');
    if (!existing) return;
    const wasEventSourced = await hasGoalGenesisAnchor(tx, input.goalId);
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: input.actorRef,
      action:
        input.action === 'status'
          ? 'experimental:goal_status_update'
          : 'experimental:goal_scope_update',
      subject_kind: 'goal',
      subject_id: input.goalId,
      outcome: 'success',
      payload: input.payload,
      created_at: input.now,
    });
    await applyGoalRow(
      tx,
      input.goalId,
      input.rowPatch,
      input.now,
      wasEventSourced,
      existing.version,
    );
  });
}

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

export async function createGoalFromGenesis(
  db: GoalDb,
  input: InsertGoalInput & { genesisEventId: string; snapshot: unknown },
): Promise<void> {
  const now = input.now ?? new Date();
  await writeEvent(db, {
    id: input.genesisEventId,
    actor_kind: 'system',
    actor_ref: 'goal-create',
    action: 'experimental:genesis',
    subject_kind: 'goal',
    subject_id: input.id,
    outcome: 'success',
    payload: { row: input.snapshot },
    created_at: now,
    ingest_at: now,
  });
  await upsertMaterializedIdIndex(db, {
    materialized_id: input.id,
    anchor_event_id: input.genesisEventId,
    subject_kind: 'goal',
  });
  await materializeGoalRow(db, input);
}

async function applyGoalRow(
  db: GoalDb,
  goalId: string,
  patch: Record<string, unknown>,
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
