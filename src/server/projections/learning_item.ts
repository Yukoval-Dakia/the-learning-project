// YUK-471 W2 — projectLearningItem: the IO shell around the PURE learning_item fold.
//
// The read→fold→write-through shell the learning_intent / ai_dream creation INSERT sites + the
// complete / relearn / archive(retract) sites flip to as the SOLE writer of a `learning_item` row
// WHEN the per-entity flag projectionIsWriter('learning_item') is ON (critic A1). It:
//   1. GATHERS the events that can affect `itemId` (Q1-only via gather.ts — the pure reducer filters
//      internally, but the shell over-collects so a missed event can never silently drop a mutation),
//   2. maps each DB row → the flat FoldEvent envelope (inside gather.ts),
//   3. calls foldLearningItem(itemId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected SNAPSHOT columns.
//
// ── EXCLUDED columns (design §3①, mirrors knowledge's embed_* exclusion) ─────────────────────────
// child_learning_item_ids / ai_score / due_at / reviewed_at are EXCLUDED from the snapshot — no
// write path / derived state the fold does NOT own. They are omitted from BOTH the INSERT values
// (left at their column defaults on a fresh row: child_learning_item_ids → [], the others → NULL)
// AND the UPDATE set (preserved untouched on an existing row), exactly like the node shell drops
// embed_*. user_pinned IS in the snapshot (genesis carries it verbatim) so it IS written through.
//
// The read→fold half lives in the SHARED gather.ts (gatherAndFoldLearningItem) so this shell and
// scripts/audit-projection.ts reconstruct a learning_item IDENTICALLY — a single gather
// implementation means the drift auditor can never be blind to a gather bug in the SoT path. This
// shell adds only the WRITE-THROUGH on top of that shared read→fold (mirrors projectGoal).
//
// Db|Tx polymorphic.

import { eq } from 'drizzle-orm';

import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { learning_item } from '@/db/schema';
import { gatherAndFoldLearningItem } from './gather';
import { hasLearningItemGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Project the current structural state of a single `learning_item` from the event log and write it
 * through to the live table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM learning_item WHERE id=itemId (row never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target learning_item.id) the projected snapshot
 *     columns (excluded cols left at default on insert / untouched on update).
 *
 * @param db     Db or Tx (polymorphic — wired sites call it inside the creation/complete/archive tx).
 * @param itemId the learning_item row id to project.
 */
export async function projectLearningItem(db: DbLike, itemId: string): Promise<void> {
  const projected = await gatherAndFoldLearningItem(db, itemId);
  if (projected === null) {
    await db.delete(learning_item).where(eq(learning_item.id, itemId));
    return;
  }
  await upsertProjectedLearningItem(db, projected);
}

/**
 * The GUARDED learning_item write-through (the SoT-flip row writer). Identical to
 * projectLearningItem EXCEPT the null branch: a fold of null DELETEs the live row ONLY when the row
 * HAS a genesis anchor (a genuine revert of an event-sourced item). A fold-null on an UN-anchored
 * row — a pre-event-sourced row the fold is blind to — must NOT delete the live row. Mirrors
 * projectGoalGuarded: lets the flip be activated before every item is backfilled.
 */
export async function projectLearningItemGuarded(db: DbLike, itemId: string): Promise<void> {
  const projected = await gatherAndFoldLearningItem(db, itemId);
  if (projected === null) {
    if (await hasLearningItemGenesisAnchor(db, itemId)) {
      await db.delete(learning_item).where(eq(learning_item.id, itemId));
    }
    // else: fold-blind pre-event-sourced item — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedLearningItem(db, projected);
}

// Shared upsert of the projected SNAPSHOT columns. The EXCLUDED columns (child_learning_item_ids /
// ai_score / due_at / reviewed_at) are deliberately omitted from BOTH the INSERT values (left at
// their defaults on a fresh row) and the UPDATE set (preserved on an existing row) — the fold does
// not own those non-structural / derived columns (mirrors the node shell's embed_* exclusion).
async function upsertProjectedLearningItem(
  db: DbLike,
  projected: LearningItemRowSnapshotT,
): Promise<void> {
  await db
    .insert(learning_item)
    .values({
      id: projected.id,
      source: projected.source,
      source_ref: projected.source_ref,
      title: projected.title,
      content: projected.content,
      knowledge_ids: projected.knowledge_ids,
      primary_artifact_id: projected.primary_artifact_id,
      parent_learning_item_id: projected.parent_learning_item_id,
      status: projected.status,
      user_pinned: projected.user_pinned,
      completed_at: projected.completed_at,
      dismissed_at: projected.dismissed_at,
      archived_at: projected.archived_at,
      archived_reason: projected.archived_reason,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
      version: projected.version,
    })
    .onConflictDoUpdate({
      target: learning_item.id,
      set: {
        source: projected.source,
        source_ref: projected.source_ref,
        title: projected.title,
        content: projected.content,
        knowledge_ids: projected.knowledge_ids,
        primary_artifact_id: projected.primary_artifact_id,
        parent_learning_item_id: projected.parent_learning_item_id,
        status: projected.status,
        user_pinned: projected.user_pinned,
        completed_at: projected.completed_at,
        dismissed_at: projected.dismissed_at,
        archived_at: projected.archived_at,
        archived_reason: projected.archived_reason,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}
