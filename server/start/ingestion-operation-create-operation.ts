import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const createStartIngestionOperation = ({
  sessionId,
  body,
  key,
}: {
  sessionId: string;
  body: string;
  key: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestIngestionOperation } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestIngestionOperation(
        db,
        { id: sessionId },
        async () => JSON.parse(body),
        key,
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
