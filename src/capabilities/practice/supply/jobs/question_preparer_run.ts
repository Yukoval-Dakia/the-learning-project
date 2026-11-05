import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runQuestionPreparer } from '../server/question-preparer';

export function buildQuestionPreparerHandler(db: Db) {
  return async (jobs: Job[]) => {
    for (const job of jobs)
      await runQuestionPreparer(
        db,
        job.id,
        job.data,
        'retryCount' in job ? Number(job.retryCount) : 0,
      );
  };
}
