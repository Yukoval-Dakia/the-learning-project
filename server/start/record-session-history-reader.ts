import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const readStartRecordSessionHistory = (id: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionHistory } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessionHistory(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });
