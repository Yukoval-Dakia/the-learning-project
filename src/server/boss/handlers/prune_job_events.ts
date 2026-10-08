import { lt } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

/**
 * 删除 30 天前的 job_events 行。
 * SSE replay 不需要这么老的事件，定期清理避免 job_events 表无限增长。
 */
export async function runPruneJobEvents(
  db: Pick<Db, 'delete'>,
  cutoff = new Date(Date.now() - 30 * 86400 * 1000),
): Promise<{ deleted: number }> {
  const result = await db.delete(job_events).where(lt(job_events.occurred_at, cutoff));
  // postgres-js returns rowCount as `count` on the result
  const deleted = (result as { count?: number }).count ?? 0;
  return { deleted };
}
