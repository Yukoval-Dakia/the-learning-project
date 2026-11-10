import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { installJobStreamGate } from '@/kernel/job-event-stream';
import { COPILOT_RUN_TABLE } from './copilot-run-status';

/**
 * Admission gate for the generic copilot_run job-events channel. The channel
 * key is the ask event id, so the session's deletion columns resolve through
 * one join. A deleting or deleted conversation reads as no channel: fresh
 * replay gets the route's 404 and an in-flight stream is cut at the next
 * replay tick. Installed once per serving process alongside the other host
 * operations.
 */
export function installCopilotJobStreamGate(): void {
  installJobStreamGate(COPILOT_RUN_TABLE, async (db: Db, runId: string) => {
    const rows = await db.execute<{ deleted: boolean }>(sql`
      SELECT (ls.deletion_requested_at IS NOT NULL OR ls.deleted_at IS NOT NULL) AS deleted
      FROM event e
      JOIN learning_session ls ON ls.id = e.session_id
      WHERE e.id = ${runId}
    `);
    const row = rows[0];
    return row != null && !row.deleted;
  });
}
