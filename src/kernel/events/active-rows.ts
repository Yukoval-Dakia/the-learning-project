// Helpers for capability-owned event read models; envelope storage and correction
// status live in @/kernel/events.

import type { Db, Tx } from '@/db/client';
import type { event } from '@/db/schema';
import { type CorrectionStatus, getCorrectionStatuses } from './corrections';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

function hasActiveCorrectionStatus(status: CorrectionStatus | undefined): boolean {
  return status?.state === 'active';
}

// Shared deterministic order for capability-owned event read models.
export function newerEventRow(a: EventRow, b: EventRow): boolean {
  return (
    a.created_at > b.created_at ||
    (a.created_at.getTime() === b.created_at.getTime() &&
      (a.dispatch_seq > b.dispatch_seq || (a.dispatch_seq === b.dispatch_seq && a.id > b.id)))
  );
}

/** Ascending form of newerEventRow; one ordering rule, not a second copy. */
export function compareEventRowsAsc(a: EventRow, b: EventRow): number {
  if (newerEventRow(b, a)) return -1;
  if (newerEventRow(a, b)) return 1;
  return 0;
}

export async function takeActiveRows(
  db: DbLike,
  firstRows: EventRow[],
  limit: number,
  fetchNextRows: (limit: number, offset: number) => Promise<EventRow[]>,
): Promise<EventRow[]> {
  const batchSize = Math.max(limit * 3, limit);
  const activeRows: EventRow[] = [];
  let rows = firstRows;
  let offset = firstRows.length;

  while (rows.length > 0) {
    const statuses = await getCorrectionStatuses(
      db,
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      if (hasActiveCorrectionStatus(statuses.get(row.id))) {
        activeRows.push(row);
        if (activeRows.length >= limit) return activeRows;
      }
    }
    if (rows.length < batchSize) break;
    rows = await fetchNextRows(batchSize, offset);
    offset += rows.length;
  }

  return activeRows;
}

export async function filterActiveRows(db: DbLike, rows: EventRow[]): Promise<EventRow[]> {
  if (rows.length === 0) return [];
  const statuses = await getCorrectionStatuses(
    db,
    rows.map((r) => r.id),
  );
  return rows.filter((row) => hasActiveCorrectionStatus(statuses.get(row.id)));
}
