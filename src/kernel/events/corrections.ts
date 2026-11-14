import { type SQLWrapper, and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { CorrectEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export type CorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_event_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_event_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_event_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_event_id: string };

/** Canonical state plus the receipt that won the timestamp/dispatch/id fold. */
export interface CorrectionStatusWithReceipt {
  readonly status: CorrectionStatus;
  readonly winning_correction_event_id: string | null;
}

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

/**
 * SQL pre-filter for getCorrectionStatuses' latest-write-wins fold: true when the
 * target's latest kind-valid correction leaves it active. Readers use it to drop
 * corrected rows before a LIMIT window; the TS fold (full schema, dispatch_seq
 * tiebreak) stays authoritative. Keep the SQL ordering identical to that fold;
 * otherwise a same-timestamp correction can pass or fail this predicate contrary
 * to the canonical winner.
 */
export function eventCorrectionActiveSql(targetEventId: SQLWrapper) {
  return sql`COALESCE((
    SELECT correction.payload->>'correction_kind'
    FROM ${event} AS correction
    WHERE correction.action = 'correct'
      AND correction.subject_kind = 'event'
      AND correction.subject_id = ${targetEventId}
      AND (
        (correction.payload->>'correction_kind' = 'supersede'
          AND COALESCE(correction.payload->>'replacement_event_id', '') <> '')
        OR (correction.payload->>'correction_kind' IN
            ('retract', 'mark_wrong', 'restore')
          AND NOT correction.payload ? 'replacement_event_id')
      )
    ORDER BY correction.created_at DESC, correction.dispatch_seq DESC, correction.id DESC
    LIMIT 1
  ), '') NOT IN ('retract', 'mark_wrong', 'supersede')`;
}

export async function getCorrectionStatus(
  db: DbLike,
  targetEventId: string,
): Promise<CorrectionStatus> {
  const statuses = await getCorrectionStatuses(db, [targetEventId]);
  return statuses.get(targetEventId) ?? activeCorrectionStatus();
}

export function getCorrectionStatuses(
  db: DbLike,
  targetEventIds: string[],
  opts?: { createdBefore?: Date },
): Promise<Map<string, CorrectionStatus>>;
export function getCorrectionStatuses(
  db: DbLike,
  targetEventIds: string[],
  opts: { createdBefore?: Date; includeReceipts: true },
): Promise<Map<string, CorrectionStatusWithReceipt>>;
export async function getCorrectionStatuses(
  db: DbLike,
  targetEventIds: string[],
  opts: { createdBefore?: Date; includeReceipts?: boolean } = {},
): Promise<Map<string, CorrectionStatus | CorrectionStatusWithReceipt>> {
  const receipts = await foldCorrectionStatuses(db, targetEventIds, opts);
  if (opts.includeReceipts === true) return receipts;
  return new Map([...receipts].map(([targetEventId, receipt]) => [targetEventId, receipt.status]));
}

async function foldCorrectionStatuses(
  db: DbLike,
  targetEventIds: string[],
  opts: { createdBefore?: Date } = {},
): Promise<Map<string, CorrectionStatusWithReceipt>> {
  const ids = Array.from(new Set(targetEventIds));
  const statuses = new Map<string, CorrectionStatusWithReceipt>();
  for (const id of ids) {
    statuses.set(id, {
      status: activeCorrectionStatus(),
      winning_correction_event_id: null,
    });
  }
  if (ids.length === 0) return statuses;

  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'event'),
        inArray(event.subject_id, ids),
        opts.createdBefore ? lt(event.created_at, opts.createdBefore) : undefined,
      ),
    )
    .orderBy(asc(event.created_at), asc(event.dispatch_seq), asc(event.id));

  for (const row of rows) {
    const parsed = CorrectEvent.safeParse(rowToCorrectEventInput(row));
    if (!parsed.success) {
      console.warn('getCorrectionStatuses: skipping malformed correction event', {
        event_id: row.id,
        error: parsed.error,
      });
      continue;
    }

    const targetEventId = parsed.data.subject_id;
    const { correction_kind, replacement_event_id } = parsed.data.payload;
    if (!statuses.has(targetEventId)) continue;

    switch (correction_kind) {
      case 'retract':
        statuses.set(targetEventId, {
          status: {
            state: 'retracted',
            correction_event_id: row.id,
            replacement_event_id: null,
          },
          winning_correction_event_id: row.id,
        });
        break;
      case 'mark_wrong':
        statuses.set(targetEventId, {
          status: {
            state: 'marked_wrong',
            correction_event_id: row.id,
            replacement_event_id: null,
          },
          winning_correction_event_id: row.id,
        });
        break;
      case 'supersede':
        if (!replacement_event_id) continue;
        statuses.set(targetEventId, {
          status: {
            state: 'superseded',
            correction_event_id: row.id,
            replacement_event_id,
          },
          winning_correction_event_id: row.id,
        });
        break;
      case 'restore':
        statuses.set(targetEventId, {
          status: activeCorrectionStatus(),
          winning_correction_event_id: row.id,
        });
        break;
    }
  }

  return statuses;
}
