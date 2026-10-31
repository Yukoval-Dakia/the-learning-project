import { and, lt, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

/** SSE 回放用不到这么旧的事件。 */
export async function runPruneJobEvents(
  db: Pick<Db, 'delete'>,
  cutoff = new Date(Date.now() - 30 * 86400 * 1000),
): Promise<{ deleted: number }> {
  // Until a durable reply freezes public prose, retain its original stream
  // (including execution/cancel evidence) even across a long recovery outage.
  // Afterwards deltas use the usual TTL; keep the compact original terminal
  // suffix so SSE reconnect still receives real event ids and the frozen body.
  const result = await db.delete(job_events).where(
    and(
      lt(job_events.occurred_at, cutoff),
      sql`(${job_events.business_table} <> 'copilot_run' or (
      not (${job_events.event_type} in ('copilot_run.reply', 'copilot_run.done', 'copilot_run.failed')
        and coalesce(${job_events.payload}->'public_prose'->>'version', '') = '1')
      and (
        not exists (select 1 from job_events as public_delta
          where public_delta.business_table = 'copilot_run'
            and public_delta.business_id = ${job_events.business_id}
            and public_delta.event_type = 'copilot_run.delta')
        or exists (select 1 from event as prose_reply
          where prose_reply.action = 'experimental:copilot_reply'
            and prose_reply.caused_by_event_id = ${job_events.business_id}
            and prose_reply.outcome in ('success', 'failure')
            and prose_reply.payload->'public_prose'->>'version' = '1')
      )
    ))`,
    ),
  );
  // postgres-js puts the delete count on `count`, not `rowCount`.
  const deleted = (result as { count?: number }).count ?? 0;
  return { deleted };
}
