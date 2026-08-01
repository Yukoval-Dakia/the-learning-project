import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import { copilotRunTerminalSql } from '@/capabilities/copilot/server/copilot-run-terminal-sql';
import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

/** Hard backlog ceiling for paid durable Copilot runs (YUK-693). */
export const MAX_OUTSTANDING_DURABLE_RUNS = 5;

/** Count runs with a QUEUED event and no successful/failed terminal event. */
export async function countOutstandingDurableRuns(db: Db): Promise<number> {
  const terminalPredicate = copilotRunTerminalSql(
    sql.raw('terminal.event_type'),
    sql.raw('terminal.payload'),
  );
  // Keep this as one raw aggregate query: the route's unit harness supplies the
  // existing `db.execute` seam, while real DB tests exercise the SQL contract.
  const rows = (await db.execute(sql<{ count: number }>`
    SELECT count(DISTINCT queued.business_id)::int AS count
    FROM job_events queued
    WHERE queued.business_table = ${COPILOT_RUN_TABLE}
      AND queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND NOT EXISTS (
        SELECT 1
        FROM job_events terminal
        WHERE terminal.business_table = queued.business_table
          AND terminal.business_id = queued.business_id
          AND ${terminalPredicate}
      )
  `)) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}
