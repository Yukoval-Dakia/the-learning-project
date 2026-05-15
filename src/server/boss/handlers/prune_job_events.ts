import { lt } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

/**
 * 删除 30 天前的 job_events 行。
 * SSE replay 不需要这么老的事件，定期清理避免 job_events 表无限增长。
 */
export async function runPruneJobEvents(db: Db): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000);
  const result = await db.delete(job_events).where(lt(job_events.occurred_at, cutoff));
  // postgres-js returns rowCount as `count` on the result
  const deleted = (result as { count?: number }).count ?? 0;
  return { deleted };
}

export function buildPruneJobEventsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runPruneJobEvents(db);
    console.log('[prune_job_events] result', result);
  };
}
