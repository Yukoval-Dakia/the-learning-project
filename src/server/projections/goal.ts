// Write-through shell for the pure `goal` fold: gather the event superset, fold it,
// then delete or upsert the live row. The read→fold half lives in gather.ts so the
// auditor reconstructs a goal identically.

import { eq } from 'drizzle-orm';

import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { gatherAndFoldGoal } from './gather';
import { hasGoalGenesisAnchor } from './parity';

type DbLike = Db | Tx;

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
  await db
    .insert(goal)
    .values({
      id: projected.id,
      title: projected.title,
      subject_id: projected.subject_id,
      scope_knowledge_ids: projected.scope_knowledge_ids,
      // Legacy payloads default to 'explicit'; the ?? only satisfies the optional snapshot type.
      scope_mode: projected.scope_mode ?? 'explicit',
      sequence_hint: projected.sequence_hint,
      // Legacy snapshots carry no declared_stage; the fold materializes NULL.
      declared_stage: projected.declared_stage ?? null,
      status: projected.status,
      source: projected.source,
      source_ref: projected.source_ref,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
      version: projected.version,
    })
    .onConflictDoUpdate({
      target: goal.id,
      set: {
        title: projected.title,
        subject_id: projected.subject_id,
        scope_knowledge_ids: projected.scope_knowledge_ids,
        scope_mode: projected.scope_mode ?? 'explicit',
        sequence_hint: projected.sequence_hint,
        declared_stage: projected.declared_stage ?? null,
        status: projected.status,
        source: projected.source,
        source_ref: projected.source_ref,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}
