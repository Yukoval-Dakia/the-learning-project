import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const readStartLibraryDrafts = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readPracticeDraftList } = await import(
        '@/capabilities/practice/question-bank/public'
      );
      const { db } = await import('@/db/client');
      return await readPracticeDraftList(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });
