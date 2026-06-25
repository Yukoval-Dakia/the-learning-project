// YUK-471 W2 — projectGoal: the IO shell around the PURE goal fold.
//
// The read→fold→write-through shell the goal accept / retract / status-scope sites flip to as
// the SOLE writer of a `goal` row WHEN the per-entity flag projectionIsWriter('goal') is ON
// (critic A1). It:
//   1. GATHERS the superset of `event` rows that can affect `goalId` (the pure reducer filters
//      internally, but the shell over-collects — a missed event silently drops a mutation),
//   2. maps each DB row → the flat FoldEvent envelope (inside gather.ts),
//   3. calls foldGoal(goalId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected columns.
//
// goal has NO derived/excluded columns (unlike knowledge's embed_*), so the upsert covers the
// full row — every column is fold truth.
//
// The read→fold half lives in the SHARED gather.ts (gatherAndFoldGoal) so this shell and
// scripts/audit-projection.ts reconstruct a goal IDENTICALLY — a single gather implementation
// means the drift auditor can never be blind to a gather bug in the SoT path. This shell adds
// only the WRITE-THROUGH on top of that shared read→fold (mirrors projectKnowledgeNode).
//
// Db|Tx polymorphic.

import { eq } from 'drizzle-orm';

import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { gatherAndFoldGoal } from './gather';
import { hasGoalGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current structural state of a single `goal` from the event log and write it
 * through to the live `goal` table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM goal WHERE id=goalId (goal never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target goal.id) the projected columns.
 *
 * @param db      Db or Tx (polymorphic — wired sites call it inside the accept/retract tx).
 * @param goalId  the goal row id to project.
 */
export async function projectGoal(db: DbLike, goalId: string): Promise<void> {
  const projected = await gatherAndFoldGoal(db, goalId);
  if (projected === null) {
    await db.delete(goal).where(eq(goal.id, goalId));
    return;
  }
  await upsertProjectedGoal(db, projected);
}

/**
 * The GUARDED goal write-through (the SoT-flip row writer). Identical to projectGoal EXCEPT the
 * null branch: a fold of null DELETEs the live row ONLY when the goal HAS a genesis anchor (a
 * genuine revert of an event-sourced goal). A fold-null on an UN-anchored goal — a pre-event-
 * sourced row the fold is blind to — must NOT delete the live row. Mirrors
 * projectKnowledgeNodeGuarded: lets the flip be activated before every goal is backfilled.
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

// Shared upsert of the projected goal columns (the FULL row — no derived/excluded columns).
async function upsertProjectedGoal(db: DbLike, projected: GoalRowSnapshotT): Promise<void> {
  await db
    .insert(goal)
    .values({
      id: projected.id,
      title: projected.title,
      subject_id: projected.subject_id,
      scope_knowledge_ids: projected.scope_knowledge_ids,
      sequence_hint: projected.sequence_hint,
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
        sequence_hint: projected.sequence_hint,
        status: projected.status,
        source: projected.source,
        source_ref: projected.source_ref,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}
