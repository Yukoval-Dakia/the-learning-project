import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';

export type JobEventInput = {
  business_table: string;
  business_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

/**
 * Insert a row into `job_events` and fire `pg_notify('job_status', …)` —— **both
 * within the same transaction**, so the NOTIFY only fires after the caller's tx
 * commits. This is the source-of-truth for async job state transitions.
 *
 * MUST be called with a tx (not the global db), per Sub 0c plan Step 3.3。
 * 调用方在自己的事务里调，保证 INSERT + NOTIFY + 业务状态写入三者原子。
 *
 * @returns the auto-assigned job_events.id (used by SSE replay as cursor)
 */
export async function writeJobEvent(tx: Db | Tx, input: JobEventInput): Promise<number> {
  const result = await tx
    .insert(job_events)
    .values({
      business_table: input.business_table,
      business_id: input.business_id,
      event_type: input.event_type,
      payload: input.payload,
      occurred_at: new Date(),
    })
    .returning({ id: job_events.id });
  const id = result[0]?.id;
  if (id == null) {
    throw new Error('writeJobEvent: INSERT did not return id');
  }
  const notificationPayload = JSON.stringify({
    event_id: id,
    business_table: input.business_table,
    business_id: input.business_id,
  });
  // pg_notify within the same tx fires on commit. We pass the payload via
  // parameter to avoid SQL-injection through caller-supplied business_id etc.
  await tx.execute(sql`SELECT pg_notify('job_status', ${notificationPayload})`);
  return id;
}
