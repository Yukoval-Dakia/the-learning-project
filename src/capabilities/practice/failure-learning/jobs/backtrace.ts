import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { backtrace_work } from '@/db/schema';
import { loadBacktraceInput } from '../server/backtrace-input';
import { writeAttemptInsight, writeBacktraceJudgement } from '../server/backtrace-writer';
export const buildBacktraceHandler =
  (db: Db) => async (jobs: Job<{ attempt_event_id: string; backfill_run_id?: string }>[]) => {
    for (const job of jobs) {
      try {
        await writeAttemptInsight(db, job.data.attempt_event_id, job.data.backfill_run_id);
        await writeBacktraceJudgement(db, job.data.attempt_event_id);
      } catch (error) {
        const basis = await loadBacktraceInput(db, job.data.attempt_event_id);
        if (basis)
          await db
            .insert(backtrace_work)
            .values({
              id: `backtrace-failure:${job.data.attempt_event_id}:${basis.digest}`,
              attempt_event_id: job.data.attempt_event_id,
              stage: 'preparation',
              input_digest: basis.digest,
              state: 'needs_reconciliation',
            })
            .onConflictDoNothing();
        throw error;
      }
    }
  };
