import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartPracticeQuestionDetailFunction } from './practice-question-detail-function';

export const startPracticeQuestionDetailClient: PracticeClient['getQuestionDetail'] = async (id) =>
  JSON.parse(
    await getStartPracticeQuestionDetailFunction({
      fetch: authenticatedStartFetch,
      data: id,
    }),
  );
