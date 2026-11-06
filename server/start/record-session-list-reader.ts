import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const readStartRecordSessions = (query: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessions } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessions(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });
