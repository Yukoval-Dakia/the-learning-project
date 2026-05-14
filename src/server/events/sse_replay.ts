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
 * Fetch all job_events for (businessTable, businessId) with id > lastEventId,
 * ordered by id ascending. SSE clients pass `Last-Event-ID` header on reconnect;
 * we use that to replay missed events between disconnect and resubscribe.
 *
 * 见 Sub 0c plan Step 3.3 + Step 10.3（SSE endpoint reads cursor + emits replay）。
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
