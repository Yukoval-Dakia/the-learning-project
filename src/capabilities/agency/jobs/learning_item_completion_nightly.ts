import type { Db } from '@/db/client';
import { reportJobYield } from '@/server/boss/job-yield';
import { runLearningItemCompletionNightly } from '../server/learning-item-completion-producer';

export function buildLearningItemCompletionNightlyHandler(db: Db) {
  return async () => {
    const result = await runLearningItemCompletionNightly(db);
    const goals = await runLearningItemCompletionNightly(db, 'goal');
    console.log('[learning_item_completion_nightly]', { learningItems: result, goals });
    return reportJobYield('learning_item_completion_nightly', {
      attempted: result.considered + goals.considered,
      succeeded: result.considered + goals.considered,
      failed: 0,
    });
  };
}
