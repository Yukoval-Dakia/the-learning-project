import { and, eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { projectGoal, projectGoalGuarded } from '@/server/projections/goal';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
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

type GoalMutation =
  | { kind: 'status'; status: GoalStatus; actorRef: string; now: Date }
  | {
      kind: 'scope';
      title?: string;
      scope_knowledge_ids?: string[];
      sequence_hint?: number;
      placement_starter_augmentation?: boolean;
      actorRef: string;
      now: Date;
    };

export async function mutateGoal(db: GoalDb, goalId: string, input: GoalMutation): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: goal.version })
      .from(goal)
      .where(eq(goal.id, goalId))
      .for('update');
    if (!existing) return;
    const wasEventSourced = await hasGoalGenesisAnchor(tx, goalId);
    const isStatus = input.kind === 'status';
    const payload = isStatus
      ? { status: input.status }
      : {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.scope_knowledge_ids !== undefined
            ? { scope_knowledge_ids: input.scope_knowledge_ids }
            : {}),
          ...(input.sequence_hint !== undefined ? { sequence_hint: input.sequence_hint } : {}),
          ...(input.placement_starter_augmentation
            ? { placement_starter_augmentation: true as const }
            : {}),
        };
    const rowPatch = isStatus
      ? { status: input.status }
      : {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.scope_knowledge_ids !== undefined
            ? { scope_knowledge_ids: input.scope_knowledge_ids }
            : {}),
          ...(input.sequence_hint !== undefined ? { sequence_hint: input.sequence_hint } : {}),
        };
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: input.actorRef,
      action: isStatus ? 'experimental:goal_status_update' : 'experimental:goal_scope_update',
      subject_kind: 'goal',
      subject_id: goalId,
      outcome: 'success',
      payload,
      created_at: input.now,
    });
    await applyGoalRow(tx, goalId, rowPatch, input.now, wasEventSourced, existing.version);
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
  input: Omit<InsertGoalInput, 'id' | 'source_ref'>,
): Promise<string> {
  const id = newId();
  const now = input.now ?? new Date();
  const genesisEventId = newId();
  const snapshot = {
    id,
    title: input.title,
    subject_id: input.subject_id ?? null,
    scope_knowledge_ids: input.scope_knowledge_ids,
    scope_mode: input.scope_mode ?? 'explicit',
    sequence_hint: input.sequence_hint,
    status: input.status ?? 'active',
    source: input.source,
    source_ref: null,
    created_at: now,
    updated_at: now,
    version: 0,
  };
  await writeEvent(db, {
    id: genesisEventId,
    actor_kind: 'system',
    actor_ref: 'goal-create',
    action: 'experimental:genesis',
    subject_kind: 'goal',
    subject_id: id,
    outcome: 'success',
    payload: { row: snapshot },
    created_at: now,
    ingest_at: now,
  });
  await upsertMaterializedIdIndex(db, {
    materialized_id: id,
    anchor_event_id: genesisEventId,
    subject_kind: 'goal',
  });
  await materializeGoalRow(db, { ...input, id, source_ref: null, now });
  return id;
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
