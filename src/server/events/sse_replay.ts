import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

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
