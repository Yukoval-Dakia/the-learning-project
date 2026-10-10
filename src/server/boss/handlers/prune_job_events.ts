import { and, lt, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

/**
 * 删除 30 天前的 SSE job_events 行，保留付费复核的操作凭据。
 * SSE replay 不需要这么老的事件，定期清理避免 job_events 表无限增长。
 */
export async function runPruneJobEvents(
  db: Pick<Db, 'delete'>,
  cutoff = new Date(Date.now() - 30 * 86400 * 1000),
): Promise<{ deleted: number }> {
  // assessmentReviewOperationId owns ingreview_v1_ identities. Their accepted,
  // started, parsed-result and terminal events are a permanent paid-call fence,
  // including unknown outcomes. Both pg-boss and DBOS use this deletion owner.
  const result = await db
    .delete(job_events)
    .where(
      and(
        lt(job_events.occurred_at, cutoff),
        sql`NOT (${job_events.business_table} = 'ingestion_operation' AND starts_with(${job_events.business_id}, 'ingreview_v1_'))`,
      ),
    );
  // postgres-js returns rowCount as `count` on the result
  const deleted = (result as { count?: number }).count ?? 0;
  return { deleted };
}
