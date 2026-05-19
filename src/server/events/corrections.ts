import { CorrectEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export type CorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_event_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_event_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_event_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_event_id: string };

export function activeCorrectionStatus(): CorrectionStatus {
  return { state: 'active', correction_event_id: null, replacement_event_id: null };
}

function rowToCorrectEventInput(row: EventRow): unknown {
  return {
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    caused_by_event_id: row.caused_by_event_id ?? undefined,
    task_run_id: row.task_run_id ?? undefined,
    cost_micro_usd: row.cost_micro_usd ?? undefined,
  };
}

export async function getCorrectionStatus(
  db: DbLike,
  targetEventId: string,
): Promise<CorrectionStatus> {
  const statuses = await getCorrectionStatuses(db, [targetEventId]);
  return statuses.get(targetEventId) ?? activeCorrectionStatus();
}

export async function getCorrectionStatuses(
  db: DbLike,
  targetEventIds: string[],
): Promise<Map<string, CorrectionStatus>> {
  const ids = Array.from(new Set(targetEventIds));
  const statuses = new Map<string, CorrectionStatus>();
  for (const id of ids) statuses.set(id, activeCorrectionStatus());
  if (ids.length === 0) return statuses;

  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'event'),
        inArray(event.subject_id, ids),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));

  for (const row of rows) {
    const parsed = CorrectEvent.safeParse(rowToCorrectEventInput(row));
    if (!parsed.success) continue;

    const targetEventId = parsed.data.subject_id;
    const { correction_kind, replacement_event_id } = parsed.data.payload;
    if (!statuses.has(targetEventId)) continue;

    switch (correction_kind) {
      case 'retract':
        statuses.set(targetEventId, {
          state: 'retracted',
          correction_event_id: row.id,
          replacement_event_id: null,
        });
        break;
      case 'mark_wrong':
        statuses.set(targetEventId, {
          state: 'marked_wrong',
          correction_event_id: row.id,
          replacement_event_id: null,
        });
        break;
      case 'supersede':
        if (!replacement_event_id) continue;
        statuses.set(targetEventId, {
          state: 'superseded',
          correction_event_id: row.id,
          replacement_event_id,
        });
        break;
      case 'restore':
        statuses.set(targetEventId, activeCorrectionStatus());
        break;
    }
  }

  return statuses;
}
