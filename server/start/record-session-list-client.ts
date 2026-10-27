import { type RecordClient, projectSessionListResponse } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartRecordSessionsFunction } from './record-session-list-function';

export const startRecordSessionsClient: RecordClient['listSessions'] = async () =>
  projectSessionListResponse(
    JSON.parse(
      await getStartRecordSessionsFunction({
        fetch: authenticatedStartFetch,
        data: 'limit=30',
      }),
    ),
  );
