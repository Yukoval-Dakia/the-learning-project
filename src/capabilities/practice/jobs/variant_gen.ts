import type { Job } from 'pg-boss';

import { createFailureLearning } from '@/capabilities/practice/server/failure-learning';
import {
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from '@/capabilities/practice/server/task-runtime';
import type { Db } from '@/db/client';
import { type FailureLearningJobData, failureLearningAttemptId } from './failure-learning-jobs';

export type VariantGenJobData = FailureLearningJobData;

interface VariantGenHandlerDeps {
  runTaskFn?: PracticeTaskRunFn;
}

/** Stable pg-boss payload adapter; all product semantics live in Failure Learning. */
export function buildVariantGenHandler(
  db: Db,
  deps: VariantGenHandlerDeps = {},
): (jobs: Job<VariantGenJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makePracticeTaskRunFn(db);
  const learning = createFailureLearning({ db, runTaskFn });
  return async (jobs) => {
    for (const job of jobs) {
      const attemptEventId = failureLearningAttemptId(job.data);
      if (!attemptEventId) {
        console.warn('[variant_gen] job missing attempt_event_id', job.id);
        continue;
      }
      try {
        const result = await learning.proposeVariant({ attemptEventId });
        console.log(`[variant_gen] ${attemptEventId} → ${result.status}`);
      } catch (err) {
        console.error(`[variant_gen] ${attemptEventId} failed`, err);
        throw err;
      }
    }
  };
}
