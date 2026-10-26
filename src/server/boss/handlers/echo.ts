import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { echo_jobs } from '@/db/schema';
import { writeJobEvent } from '@/kernel/job-events';

export type EchoJobData = {
  businessId: string;
  input: string;
};

/** 更新和事件写在同一个事务里，NOTIFY 才会在提交之后才到 SSE。 */
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
