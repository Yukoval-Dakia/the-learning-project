import type { RecordClient } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { answerStartRecordAskFunction } from './record-ask-answer-function';

export const startRecordAskAnswerClient: RecordClient['answerAsk'] = async (
  sessionId,
  askId,
  answer,
  key,
) => {
  await answerStartRecordAskFunction({
    fetch: authenticatedStartFetch,
    headers: { 'Idempotency-Key': key },
    data: { sessionId, askId, body: JSON.stringify({ answer }) },
  });
};
