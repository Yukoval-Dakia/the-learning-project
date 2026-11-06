import type { QuestionCardClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartQuestionCardFunction } from './question-card-function';

export const startQuestionCardClient: QuestionCardClient = {
  getQuestionCard: async (id) =>
    JSON.parse(await getStartQuestionCardFunction({ fetch: authenticatedStartFetch, data: id })),
};
