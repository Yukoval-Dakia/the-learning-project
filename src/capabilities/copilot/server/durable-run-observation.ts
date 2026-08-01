import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';

export interface OutstandingCopilotDurableRun {
  runId: string;
  queuedAt: Date;
  sessionId?: string;
  triggeredBy?: 'chat' | 'chip';
  bossJobId?: string;
  pickupDeadlineMs?: number;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read the oldest bounded set of accepted, non-terminal runs.
 *
 * Terminal filtering happens before LIMIT. Otherwise a retained prefix of
 * already-settled rows would make every sweep miss a later stranded run.
 * Duplicate QUEUED frames collapse to the first acceptance row.
 */
export async function findOutstandingCopilotDurableRuns(
  db: Db,
  limit: number,
): Promise<OutstandingCopilotDurableRun[]> {
  const terminalPredicate = copilotRunTerminalSql(
    sql.raw('terminal.event_type'),
    sql.raw('terminal.payload'),
  );
  const rows = (await db.execute(sql<{
    business_id: string;
    occurred_at: Date;
    payload: unknown;
  }>`
    SELECT queued.business_id, queued.occurred_at, queued.payload
    FROM job_events queued
    WHERE queued.business_table = ${COPILOT_RUN_TABLE}
      AND queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND queued.id = (
        SELECT min(first_queued.id)
        FROM job_events first_queued
        WHERE first_queued.business_table = queued.business_table
          AND first_queued.business_id = queued.business_id
          AND first_queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM job_events terminal
        WHERE terminal.business_table = queued.business_table
          AND terminal.business_id = queued.business_id
          AND ${terminalPredicate}
      )
    ORDER BY queued.occurred_at ASC, queued.id ASC
    LIMIT ${limit}
  `)) as Array<{ business_id: string; occurred_at: Date; payload: unknown }>;

  return rows.map((row) => {
    const payload = payloadRecord(row.payload);
    const triggeredBy = payload.triggered_by;
    return {
      runId: row.business_id,
      queuedAt: row.occurred_at,
      ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
      ...(triggeredBy === 'chat' || triggeredBy === 'chip' ? { triggeredBy } : {}),
      ...(typeof payload.boss_job_id === 'string' ? { bossJobId: payload.boss_job_id } : {}),
      ...(typeof payload.pickup_deadline_ms === 'number' &&
      Number.isFinite(payload.pickup_deadline_ms)
        ? { pickupDeadlineMs: payload.pickup_deadline_ms }
        : {}),
    };
  });
}
