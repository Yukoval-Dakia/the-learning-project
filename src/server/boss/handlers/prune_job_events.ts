import { lt } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';

/** SSE 回放用不到这么旧的事件。 */
export async function runPruneJobEvents(
  db: Pick<Db, 'delete'>,
  cutoff = new Date(Date.now() - 30 * 86400 * 1000),
): Promise<{ deleted: number }> {
  const result = await db.delete(job_events).where(lt(job_events.occurred_at, cutoff));
  // postgres-js puts the delete count on `count`, not `rowCount`.
  const deleted = (result as { count?: number }).count ?? 0;
  return { deleted };
}
