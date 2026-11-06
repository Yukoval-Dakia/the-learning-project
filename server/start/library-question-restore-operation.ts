import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const restoreStartLibraryQuestion = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { restorePracticeQuestion } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await restorePracticeQuestion(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
