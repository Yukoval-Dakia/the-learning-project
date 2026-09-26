import type { Job } from 'pg-boss';

import { createFailureLearning } from '@/capabilities/practice/server/failure-learning';
import {
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from '@/capabilities/practice/server/task-runtime';
import type { Db } from '@/db/client';
import { resolveVerdictForAttempt } from '@/kernel/read-models/assessment-verdict';
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
        // YUK-1054 (§9 paid fanout 抑制)— 判已翻转（effective 判变为 correct）的
        // attempt 不再产生变体：变体生成只为「真实答错」服务，改判后烧钱是浪费。
        // attempt.outcome 是 immutable 执行事实（永远 'failure'），故必须在 job 时
        // 读 effective 判复核，不能信任排队时刻的 outcome 快照。
        const verdict = await resolveVerdictForAttempt(db, attemptEventId);
        if (verdict.effective?.verdict.coarse_outcome === 'correct') {
          console.log(`[variant_gen] ${attemptEventId} → skipped:verdict_overturned`);
          continue;
        }
        const result = await learning.proposeVariant({ attemptEventId });
        console.log(`[variant_gen] ${attemptEventId} → ${result.status}`);
      } catch (err) {
        console.error(`[variant_gen] ${attemptEventId} failed`, err);
        throw err;
      }
    }
  };
}
