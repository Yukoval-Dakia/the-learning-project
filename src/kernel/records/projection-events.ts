import type { FoldEvent } from '@/core/projections/fold-event';
import type { event } from '@/db/schema';

type EventRow = typeof event.$inferSelect;

// Map one `event` row to the flat FoldEvent envelope the reducers consume. Missing
// nullable columns become null.
export function rowToFoldEvent(row: EventRow): FoldEvent {
  return {
    id: row.id,
    created_at: row.created_at,
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    caused_by_event_id: row.caused_by_event_id ?? null,
  };
}
