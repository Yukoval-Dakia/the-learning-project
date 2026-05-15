import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { echo_jobs } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';

export type EchoJobData = {
  businessId: string;
  input: string;
};

/**
 * Echo job handler —— golden E2E pattern。**反转输入字符串**作为示例业务逻辑。
 *
 * 事务内：
 *   1. UPDATE echo_jobs(output, status='completed')
 *   2. writeJobEvent(event_type='echo.completed', payload={input, output})
 *
 * 两步同事务，pg_notify 在 commit 后到达 LISTEN 客户端 → broadcast → SSE。
 */
export function buildEchoHandler(db: Db): (jobs: Job<EchoJobData>[]) => Promise<void> {
  return async (jobs: Job<EchoJobData>[]) => {
    for (const job of jobs) {
      const { businessId, input } = job.data;
      const output = input.split('').reverse().join('');
      await db.transaction(async (tx) => {
        await tx
          .update(echo_jobs)
          .set({ output, status: 'completed', updated_at: new Date() })
          .where(eq(echo_jobs.id, businessId));
        await writeJobEvent(tx, {
          business_table: 'echo_jobs',
          business_id: businessId,
          event_type: 'echo.completed',
          payload: { input, output },
        });
      });
    }
  };
}
