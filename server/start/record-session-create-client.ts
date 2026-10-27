import {
  type RecordClient,
  buildRecordSessionCreateBody,
  projectRecordSessionCreateResponse,
} from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartIngestionSessionFunction } from './ingestion-session-create-function';

export const startRecordSessionCreateClient: RecordClient['createSession'] = async (input) =>
  projectRecordSessionCreateResponse(
    JSON.parse(
      await createStartIngestionSessionFunction({
        fetch: authenticatedStartFetch,
        data: JSON.stringify(buildRecordSessionCreateBody(input)),
      }),
    ),
  );
