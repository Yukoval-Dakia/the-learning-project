import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartLibraryQuestions: FrontdoorContext['readLibraryQuestions'] = (query) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readPracticeQuestionList } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await readPracticeQuestionList(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });
