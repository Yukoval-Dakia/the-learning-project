// 学习日结转（YUK-2125）：新学习日的 compose 把旧整档案分区仍开着的行迁进新日，
// 不把学习者做了一半的流丢在再也读不到的日历日上。在 compose finalize 事务内、
// 物化 plan 之后调用——与 stream-store 的 survivors-outside-plan 约定一致。

import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { practice_stream_item } from '@/db/schema';
import {
  lockPracticeStreamCarryAdmission,
  lockPracticeStreamPartition,
} from '@/kernel/locks/practice-stream';
import { streamPartitionPredicate } from './stream-store';

/** Statuses whose work is still open and follows the learner into the next learning day. */
const CARRIED_STREAM_STATUSES = ['pending', 'in_progress'] as const;

/**
 * Statuses that own progress a carry must never overwrite or delete. A target
 * row already carrying closed or open progress (`done`, `skipped`, or an
 * `in_progress` row with its own `iss_stream_<id>` binding) wins a same-ref
 * collision; a `pending` target row has zero progress and loses to the carried
 * row that owns the learner's state. Deletion is therefore keyed on progress,
 * never on insert provenance alone.
 */
const PROGRESS_OWNED_STATUSES: ReadonlySet<string> = new Set(['done', 'skipped', 'in_progress']);

/**
 * Learning-day carry-forward (YUK-2125): when a compose materializes a *new* learning
 * day, every still-open row on earlier whole-profile partitions migrates into the new
 * day instead of being stranded on a calendar day the learner never sees again.
 *
 * Migration is an UPDATE of `date`, not delete+insert: the row id — and therefore the
 * `iss_stream_<row.id>` issuance identity and any in-flight attempt binding —
 * survives. `pending`/`in_progress` carry; `done`/`skipped` stay as closed history on
 * their original day. Scoped partitions (`session_id` set) are separate on-demand
 * review sessions with their own lifecycle and are untouched.
 *
 * Same-ref collisions against `practice_stream_daily_ref_unique` are resolved by
 * progress, never blindly:
 * - the target row carries no progress of its own (a freshly inserted plan row,
 *   or a zero-progress `pending` upload/recompose-survivor row): it is a
 *   duplicate — delete it and carry the row that owns the learner's state.
 * - the target row already owns progress (`done`/`skipped` history, or its own
 *   `in_progress` issuance binding): it wins the ref — drop the stale carried
 *   duplicate. Deletion is keyed on progress, never on insert provenance alone.
 *
 * Must run inside the compose finalize transaction after `materializePreparedCollect`
 * (so carried rows append after the fresh plan, matching the survivors-outside-plan
 * convention). A single global `stream:carry-forward` advisory lock is taken
 * before any per-source `stream:compose:<date>` lock, so two composes on
 * different target days can never wait on each other's partitions into a
 * deadlock; per-source locks are then taken in ascending-date order so a
 * carried row never races a single-partition writer (rerank / intervention)
 * on its source partition.
 */
export async function carryForwardOpenStreamItems(
  tx: Tx,
  date: string,
  freshRefs?: Set<string>,
): Promise<{ moved: number; deletedIds: Set<string> }> {
  // Admission already held by the finalize caller (G before target before
  // sources); re-taking is a no-op re-entrant lock so carry never runs
  // unadmitted.
  await lockPracticeStreamCarryAdmission(tx);
  const sourceDates = await tx
    .selectDistinct({ date: practice_stream_item.date })
    .from(practice_stream_item)
    .where(
      and(
        isNull(practice_stream_item.session_id),
        lt(practice_stream_item.date, date),
        inArray(practice_stream_item.status, [...CARRIED_STREAM_STATUSES]),
      ),
    )
    .orderBy(asc(practice_stream_item.date));
  const deletedIds = new Set<string>();
  if (sourceDates.length === 0) return { moved: 0, deletedIds };
  let moved = 0;
  for (const { date: sourceDate } of sourceDates) {
    await lockPracticeStreamPartition(tx, sourceDate);
    const openRows = await tx
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(
        and(
          streamPartitionPredicate(sourceDate),
          inArray(practice_stream_item.status, [...CARRIED_STREAM_STATUSES]),
        ),
      )
      .orderBy(asc(practice_stream_item.position));
    if (openRows.length === 0) continue;
    const targetRows = await tx
      .select({
        id: practice_stream_item.id,
        ref_id: practice_stream_item.ref_id,
        status: practice_stream_item.status,
      })
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date));
    const targetByRef = new Map(targetRows.map((row) => [row.ref_id, row]));
    const duplicateTargetIds: string[] = [];
    const staleCarriedIds: string[] = [];
    const carryRows: typeof openRows = [];
    for (const row of openRows) {
      const target = targetByRef.get(row.ref_id);
      if (target === undefined) {
        carryRows.push(row);
      } else if (freshRefs?.has(row.ref_id) || !PROGRESS_OWNED_STATUSES.has(target.status)) {
        // The target row has no progress of its own: a freshly inserted plan
        // row (`freshRefs`) or a zero-progress pending row (upload insert,
        // kept recompose survivor). The carried row owns the learner's state —
        // delete the duplicate target, carry the progress-owning row.
        duplicateTargetIds.push(target.id);
        carryRows.push(row);
      } else {
        // Target already owns progress (done/skipped, or its own in_progress
        // binding): it wins the ref; drop the stale carried duplicate.
        staleCarriedIds.push(row.id);
      }
    }
    const deleteIds = [...duplicateTargetIds, ...staleCarriedIds];
    if (deleteIds.length > 0) {
      await tx.delete(practice_stream_item).where(inArray(practice_stream_item.id, deleteIds));
      for (const id of deleteIds) deletedIds.add(id);
    }
    if (carryRows.length === 0) continue;
    const [tail] = await tx
      .select({ position: sql<number>`coalesce(max(${practice_stream_item.position}), 0)::int` })
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date));
    const now = new Date();
    for (const [index, row] of carryRows.entries()) {
      await tx
        .update(practice_stream_item)
        .set({ date, position: tail.position + index + 1, updated_at: now })
        .where(eq(practice_stream_item.id, row.id));
    }
    moved += carryRows.length;
  }
  return { moved, deletedIds };
}
