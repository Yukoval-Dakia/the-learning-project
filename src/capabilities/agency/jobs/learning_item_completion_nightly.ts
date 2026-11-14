import type { Db } from '@/db/client';
import { reportJobYield } from '@/server/boss/job-yield';
import { runLearningItemCompletionNightly } from '../server/learning-item-completion-producer';

export function buildLearningItemCompletionNightlyHandler(db: Db) {
  return async () => {
    const result = await runLearningItemCompletionNightly(db);
    console.log('[learning_item_completion_nightly]', result);
    return reportJobYield('learning_item_completion_nightly', {
      attempted: result.considered,
      succeeded: result.considered,
      failed: 0,
    });
  };
}
