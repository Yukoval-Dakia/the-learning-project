import type { FoldEvent } from '@/core/projections/fold-event';

// The columns a fold actually reads. Queries that only feed reducers may select
// this narrower set instead of the full row; the full `event` row is a superset.
export interface FoldEventRow {
  id: string;
  created_at: Date;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  payload: Record<string, unknown>;
  caused_by_event_id: string | null;
}

// Map one `event` row to the flat FoldEvent envelope the reducers consume. Missing
// nullable columns become null.
export function rowToFoldEvent(row: FoldEventRow): FoldEvent {
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
