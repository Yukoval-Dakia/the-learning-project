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
 * Insert the job event and NOTIFY in the caller's transaction, so the
 * notification fires only after commit. Job state must be written in that same
 * transaction for the three writes to stay atomic.
 *
 * @returns the job_events.id, which SSE replay uses as its cursor
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
  // Parameter binding keeps caller-supplied ids out of the SQL text.
  await tx.execute(sql`SELECT pg_notify('job_status', ${notificationPayload})`);
  return id;
}
