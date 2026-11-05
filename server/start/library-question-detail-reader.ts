import type { readQuestionDetail } from '@/capabilities/practice/question-bank/public';
import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

export const readStartLibraryQuestionDetail = (
  id: string,
): Promise<Awaited<ReturnType<typeof readQuestionDetail>>> =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readQuestionDetail } = await import('@/capabilities/practice/question-bank/public');
      const { db } = await import('@/db/client');
      return await readQuestionDetail(db, { id }, { timelineLimit: null, surface: null });
    } catch (error) {
      throw errorResponse(error);
    }
  });
