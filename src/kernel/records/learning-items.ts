// Shared creation and structural materialization for event-native learning items.
// Derived child_learning_item_ids / ai_score / due_at / reviewed_at remain outside the snapshot.

import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { newId } from '@/core/ids';
import { foldLearningItem } from '@/core/projections/learning_item';
import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import type {
  LearningItemKnowledgeIdsRewriteExperimental,
  LearningItemStateRestoreExperimental,
} from '@/core/schema/event/learning-item-events';
import type { Db, Tx } from '@/db/client';
import { event, learning_item, materialized_id_index } from '@/db/schema';
import { nextProjectionEventTime, writeEvent } from '@/kernel/events';
import { upsertMaterializedIdIndex } from './materialized-id-index';
import { rowToFoldEvent } from './projection-events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

/** Caller-owned facts; the creation owner supplies the shared pending state. */
export type PendingLearningItemInput = Pick<
  LearningItemRowSnapshotT,
  | 'id'
  | 'source'
  | 'source_ref'
  | 'title'
  | 'content'
  | 'knowledge_ids'
  | 'primary_artifact_id'
  | 'parent_learning_item_id'
>;

/** Create inside the caller's transaction: genesis → immutable anchor → structural projection. */
export async function createPendingLearningItem(
  tx: Tx,
  input: PendingLearningItemInput,
  now: Date,
): Promise<void> {
  const row: LearningItemRowSnapshotT = {
    ...input,
    status: 'pending',
    user_pinned: false,
    completed_at: null,
    dismissed_at: null,
    archived_at: null,
    archived_reason: null,
    created_at: now,
    updated_at: now,
    version: 0,
  };
  // Keep the creation seed out of the memory outbox, using the caller's original time.
  const genesisEventId = newId();
  await writeEvent(tx, {
    id: genesisEventId,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'learning_item',
    subject_id: row.id,
    outcome: 'success',
    payload: { row },
    created_at: now,
    ingest_at: now,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: row.id,
    anchor_event_id: genesisEventId,
    subject_kind: 'learning_item',
  });
  await projectLearningItem(tx, row.id);
}

/**
 * Re-project one `learning_item`. A fold of null deletes the row; otherwise upsert the
 * snapshot columns.
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
 * Guarded write-through: a fold of null deletes only when the row has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
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

// Upsert the snapshot columns. Derived columns stay at their defaults on insert and
// untouched on update because the fold does not own them.
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

/**
 * Prefetch the item-independent merge events and their accept rates. A full-table audit
 * folds many items, so fetching this once avoids rerunning the same scans per item.
 */
export async function prefetchLearningItemMergeEvents(db: DbLike): Promise<EventRow[]> {
  // Q3: every knowledge merge, because merges chain (A→B then B→C). The reducer applies
  // only the merges intersecting the item, in timestamp order.
  const merges = await db
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:knowledge_merge'));
  if (merges.length === 0) return [];
  // accept rates chained to the merge propose events (the reducer gates the rewrite on acceptance).
  const mergeIds = merges.map((r) => r.id);
  const rates = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, mergeIds)));
  return [...merges, ...rates];
}

/**
 * Gather the events affecting `itemId` and run the pure learning_item fold. Besides the
 * subject-keyed events, it gathers every accepted knowledge merge because a merge can
 * rewrite this item's knowledge_ids through a chain whose earlier ids are gone. Returns
 * the projected row or null.
 */
export async function gatherAndFoldLearningItem(
  db: DbLike,
  itemId: string,
  prefetchedMergeEvents?: EventRow[],
): Promise<LearningItemRowSnapshotT | null> {
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'learning_item'), eq(event.subject_id, itemId)));

  // Merge events are item-independent; a full-table caller prefetches them once.
  const mergeEvents = prefetchedMergeEvents ?? (await prefetchLearningItemMergeEvents(db));

  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...mergeEvents]) byId.set(r.id, r);

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldLearningItem(itemId, foldEvents);
}

// ── learning_item genesis-anchor helpers ──────────────────────────────────────────────────────
//
// An item is event-sourced when it has a genesis seed or an index anchor. Status/archive
// events mutate an existing row and are not anchors on their own.

const LEARNING_ITEM_ANCHOR_ACTIONS = ['experimental:genesis'] as const;

/** Whether an item has a genesis anchor the fold can reproduce. */
export async function hasLearningItemGenesisAnchor(db: DbLike, itemId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'learning_item'),
        eq(event.subject_id, itemId),
        inArray(event.action, [...LEARNING_ITEM_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, itemId),
        eq(materialized_id_index.subject_kind, 'learning_item'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/** Batch form; also serves as the backfill's idempotency pre-scan. */
export async function learningItemsWithGenesisAnchor(
  db: DbLike,
  itemIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (itemIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'learning_item'),
        inArray(event.subject_id, itemIds),
        inArray(event.action, [...LEARNING_ITEM_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, itemIds),
        eq(materialized_id_index.subject_kind, 'learning_item'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

type LearningItemRepairEvent =
  | z.infer<typeof LearningItemKnowledgeIdsRewriteExperimental>
  | z.infer<typeof LearningItemStateRestoreExperimental>;

/** Caller holds the item row lock. Anchor, causal time, append and projection stay inseparable. */
export async function applyLearningItemRepair(
  tx: Tx,
  input: LearningItemRepairEvent,
  requestedAt: Date,
): Promise<void> {
  if (!(await hasLearningItemGenesisAnchor(tx, input.subject_id))) {
    throw new Error(`Learning item ${input.subject_id} needs canonical projection migration`);
  }
  const createdAt = await nextProjectionEventTime(
    tx,
    'learning_item',
    input.subject_id,
    requestedAt,
  );
  await writeEvent(tx, { ...input, id: newId(), created_at: createdAt, ingest_at: requestedAt });
  await projectLearningItemGuarded(tx, input.subject_id);
}
