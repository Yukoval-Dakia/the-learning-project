import { eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { projectGoal, projectGoalGuarded } from '@/server/projections/goal';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import { hasGoalGenesisAnchor } from '@/server/projections/parity';
import { ensureSubjectRoot } from '@/server/subjects/ensure-subject-root';
import { getDefaultSubjectRegistry } from '@/subjects/profile';

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

type GoalScopePatch = {
  title?: string;
  scope_knowledge_ids?: string[];
  sequence_hint?: number;
};
type GoalMutation =
  | { kind: 'retract'; now: Date }
  | { kind: 'status'; status: GoalStatus; actorRef: string; now: Date }
  | (GoalScopePatch & {
      kind: 'scope';
      placement_starter_augmentation?: boolean;
      actorRef: string;
      now: Date;
    });

function goalSnapshot(input: InsertGoalInput): GoalRowSnapshotT {
  const now = input.now ?? new Date();
  return {
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
    version: 0,
  };
}

/** Import/fixture compatibility only: live creation must record its originating event. */
export async function insertLegacyGoal(db: GoalDb, input: InsertGoalInput): Promise<string> {
  await db.insert(goal).values(goalSnapshot(input));
  return input.id;
}

async function ensureGoalSubject(tx: Tx, subjectId: string | null): Promise<void> {
  if (!subjectId) return;
  const profile = getDefaultSubjectRegistry().get(subjectId);
  await ensureSubjectRoot(tx, subjectId, profile?.displayName ?? subjectId);
}

async function materializeCreatedGoal(tx: Tx, snapshot: GoalRowSnapshotT): Promise<void> {
  await ensureGoalSubject(tx, snapshot.subject_id);
  await projectGoal(tx, snapshot.id);
}

/** A user declaration owns its seed, anchor, subject and materialization atomically. */
export async function createManualGoal(
  db: GoalDb,
  input: Omit<InsertGoalInput, 'id' | 'source' | 'source_ref'>,
): Promise<string> {
  return db.transaction(async (tx) => {
    const id = newId();
    const snapshot = goalSnapshot({ ...input, id, source: 'manual' });
    const genesisEventId = newId();
    await writeEvent(tx, {
      id: genesisEventId,
      actor_kind: 'system',
      actor_ref: 'goal-create',
      action: 'experimental:genesis',
      subject_kind: 'goal',
      subject_id: id,
      outcome: 'success',
      payload: { row: snapshot },
      created_at: snapshot.created_at,
      ingest_at: snapshot.created_at,
    });
    await upsertMaterializedIdIndex(tx, {
      materialized_id: id,
      anchor_event_id: genesisEventId,
      subject_kind: 'goal',
    });
    await materializeCreatedGoal(tx, snapshot);
    return id;
  });
}

/** The caller's acceptance transaction already contains the canonical rate event. */
export async function materializeAcceptedGoal(
  tx: Tx,
  input: Omit<InsertGoalInput, 'source' | 'source_ref' | 'scope_mode' | 'status'> & {
    proposalId: string;
  },
): Promise<void> {
  await upsertMaterializedIdIndex(tx, {
    materialized_id: input.id,
    anchor_event_id: input.proposalId,
    subject_kind: 'goal',
  });
  await materializeCreatedGoal(
    tx,
    goalSnapshot({
      ...input,
      source: 'goal_scope_proposal',
      source_ref: input.proposalId,
      scope_mode: 'explicit',
      status: 'active',
    }),
  );
}

/** One lock/read/event/write boundary for status and scope; no caller-supplied row patch. */
export async function mutateGoal(db: GoalDb, goalId: string, input: GoalMutation): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: goal.version, updated_at: goal.updated_at })
      .from(goal)
      .where(eq(goal.id, goalId))
      .for('update');
    if (!existing) return;
    // Must be checked BEFORE the mutation event: a mutation cannot seed a legacy row.
    if (!(await hasGoalGenesisAnchor(tx, goalId))) {
      throw new Error(
        `Goal ${goalId} is not event-sourced; run the canonical projection migration`,
      );
    }
    // The fold orders by event time. Assign mutation time only after acquiring ownership,
    // so simultaneous or delayed callers cannot reverse the committed event sequence.
    // Retraction already has a canonical correction event and must retain its timestamp.
    const transitionAt =
      input.kind === 'retract'
        ? input.now
        : new Date(Math.max(input.now.getTime(), existing.updated_at.getTime() + 1));
    const rowPatch =
      input.kind === 'status' || input.kind === 'retract'
        ? { status: input.kind === 'retract' ? ('dormant' as const) : input.status }
        : {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.scope_knowledge_ids !== undefined
              ? { scope_knowledge_ids: input.scope_knowledge_ids }
              : {}),
            ...(input.sequence_hint !== undefined ? { sequence_hint: input.sequence_hint } : {}),
          };
    if (input.kind !== 'retract')
      await writeEvent(tx, {
        id: newId(),
        actor_kind: 'system',
        actor_ref: input.actorRef,
        action:
          input.kind === 'status'
            ? 'experimental:goal_status_update'
            : 'experimental:goal_scope_update',
        subject_kind: 'goal',
        subject_id: goalId,
        outcome: 'success',
        payload: {
          ...rowPatch,
          ...(input.kind === 'scope' && input.placement_starter_augmentation
            ? { placement_starter_augmentation: true as const }
            : {}),
        },
        created_at: transitionAt,
      });
    await projectGoalGuarded(tx, goalId);
  });
}
