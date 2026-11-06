import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const answerStartRecordAsk = ({
  sessionId,
  askId,
  body,
  key,
}: {
  sessionId: string;
  askId: string;
  body: string;
  key: string | null;
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { answerIngestionAsk } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await answerIngestionAsk(db, { id: sessionId, ask_id: askId }, key, async () =>
        JSON.parse(body),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
