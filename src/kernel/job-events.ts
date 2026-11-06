import { and, asc, eq, gt, sql } from 'drizzle-orm';
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

/**
 * Ephemeral live frames ride the NOTIFY payload itself and are never written to
 * job_events: consumers that reconnect replay nothing. pg_notify rejects
 * payloads >= ~8000 bytes, so oversize frames are dropped here (the producer's
 * own budget is tighter) rather than throwing into the caller's write path.
 */
export const JOB_LIVE_NOTIFY_CHANNEL = 'job_status_live';

const NOTIFY_PAYLOAD_BUDGET_BYTES = 7000;

export type JobLiveEventInput = {
  business_table: string;
  business_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

/** @returns false when the frame was dropped; live delivery is best-effort. */
export async function publishJobLiveEvent(db: Db, input: JobLiveEventInput): Promise<boolean> {
  const notification = JSON.stringify(input);
  const bytes = Buffer.byteLength(notification, 'utf8');
  if (bytes > NOTIFY_PAYLOAD_BUDGET_BYTES) {
    console.warn('[job-events] live frame dropped: notify payload over budget', {
      business_table: input.business_table,
      business_id: input.business_id,
      event_type: input.event_type,
      bytes,
    });
    return false;
  }
  try {
    await db.execute(sql`SELECT pg_notify(${JOB_LIVE_NOTIFY_CHANNEL}, ${notification})`);
    return true;
  } catch (error) {
    // Live payload content must never reach logs: identifiers and sizes only.
    console.warn('[job-events] live frame notify failed', {
      business_table: input.business_table,
      business_id: input.business_id,
      event_type: input.event_type,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

export type ReplayParams = {
  businessTable: string;
  businessId: string;
  lastEventId: number; // 0 = no prior cursor, return all
};

export type ReplayEvent = {
  id: number;
  business_table: string;
  business_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
};

/**
 * Fetch this stream's events after `lastEventId`, ordered by id. SSE clients pass
 * the cursor as `Last-Event-ID` to replay what they missed while disconnected.
 */
export async function computeReplay(db: Db, params: ReplayParams): Promise<ReplayEvent[]> {
  const rows = await db
    .select()
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, params.businessTable),
        eq(job_events.business_id, params.businessId),
        gt(job_events.id, params.lastEventId),
      ),
    )
    .orderBy(asc(job_events.id));

  return rows.map((r) => ({
    id: r.id,
    business_table: r.business_table,
    business_id: r.business_id,
    event_type: r.event_type,
    payload: r.payload,
    occurred_at: r.occurred_at,
  }));
}
