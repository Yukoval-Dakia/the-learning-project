import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const changeStartRecordPurpose = ({
  sessionId,
  body,
}: {
  sessionId: string;
  body: string;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestPurposeChange } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestPurposeChange(db, { id: sessionId }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
