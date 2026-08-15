// Shared active-row helpers for capability-owned event read models.
//
// Concrete semantic projections live with their owning capabilities. Generic
// envelope storage and correction-status evaluation live in @/kernel/events.

import type { Db, Tx } from '@/db/client';
import type { event } from '@/db/schema';
import { type CorrectionStatus, getCorrectionStatuses } from '@/kernel/events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

function hasActiveCorrectionStatus(status: CorrectionStatus | undefined): boolean {
  return status?.state === 'active';
}

// Deterministic (created_at, dispatch_seq, id) ordering is shared by
// capability-owned event read models.
export function newerEventRow(a: EventRow, b: EventRow): boolean {
  return (
    a.created_at > b.created_at ||
    (a.created_at.getTime() === b.created_at.getTime() &&
      (a.dispatch_seq > b.dispatch_seq || (a.dispatch_seq === b.dispatch_seq && a.id > b.id)))
  );
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
