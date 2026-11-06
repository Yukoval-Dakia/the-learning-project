import type { QuestionCardClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartQuestionCardFunction } from './question-card-function';

export const startQuestionCardReadClient: QuestionCardClient['getQuestionCard'] = async (
  id,
  sessionId,
) =>
  JSON.parse(
    await getStartQuestionCardFunction({
      fetch: authenticatedStartFetch,
      data: { id, sessionId },
    }),
  );
