import {
  type RecordClient,
  buildRecordManualMistakeBody,
} from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartRecordManualMistakeFunction } from './record-manual-mistake-function';

export const startRecordManualMistakeClient: RecordClient['createWrongAnswer'] = async (input) =>
  JSON.parse(
    await createStartRecordManualMistakeFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify(buildRecordManualMistakeBody(input)),
    }),
  );
