// 学习日结转（YUK-2125）：新学习日的 compose 把旧整档案分区仍开着的行迁进新日，
// 不把学习者做了一半的流丢在再也读不到的日历日上。在 compose finalize 事务内、
// 物化 plan 之后调用——与 stream-store 的 survivors-outside-plan 约定一致。

import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { practice_stream_item } from '@/db/schema';
import { lockPracticeStreamPartition } from '@/kernel/locks/practice-stream';
import { streamPartitionPredicate } from './stream-store';

/** Statuses whose work is still open and follows the learner into the next learning day. */
const CARRIED_STREAM_STATUSES = ['pending', 'in_progress'] as const;

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
 * - ref newly inserted by *this* plan (`freshRefs`): the plan row is a duplicate
 *   with no progress — delete it and carry the row that owns the learner's state.
 * - ref already on the target before this compose (uploads, kept rows): the target
 *   row owns the ref — drop the stale carried duplicate.
 *
 * Must run inside the compose finalize transaction after `materializePreparedCollect`
 * (so carried rows append after the fresh plan, matching the survivors-outside-plan
 * convention), with the target partition lock already held; each source partition is
 * locked in ascending-date order before its rows move, so a carried row can never
 * race with a rerank on its source partition.
 */
export async function carryForwardOpenStreamItems(
  tx: Tx,
  date: string,
  freshRefs?: Set<string>,
): Promise<{ moved: number; deletedIds: Set<string> }> {
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
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date));
    const targetIdByRef = new Map(targetRows.map((row) => [row.ref_id, row.id]));
    const duplicateTargetIds: string[] = [];
    const staleCarriedIds: string[] = [];
    const carryRows: typeof openRows = [];
    for (const row of openRows) {
      const targetId = targetIdByRef.get(row.ref_id);
      if (targetId === undefined) {
        carryRows.push(row);
      } else if (freshRefs?.has(row.ref_id)) {
        duplicateTargetIds.push(targetId);
        carryRows.push(row);
      } else {
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
