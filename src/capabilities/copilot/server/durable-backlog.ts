import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

/** Hard backlog ceiling for paid durable Copilot runs (YUK-693). */
export const MAX_OUTSTANDING_DURABLE_RUNS = 5;

/** Count runs with a QUEUED event and no successful/failed terminal event. */
export async function countOutstandingDurableRuns(db: Db): Promise<number> {
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
          AND terminal.event_type IN (${COPILOT_RUN_EVENTS.DONE}, ${COPILOT_RUN_EVENTS.FAILED})
      )
  `)) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}
