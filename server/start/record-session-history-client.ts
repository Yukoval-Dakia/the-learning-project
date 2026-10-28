import type { RecordClient } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartRecordSessionHistoryFunction } from './record-session-history-function';

const fetchRecordSessionHistory: typeof fetch = (input, init) =>
  authenticatedStartFetch(input, { ...init, cache: 'no-store' });

export const startRecordSessionHistoryClient: RecordClient['getHistory'] = async (id) =>
  JSON.parse(
    await getStartRecordSessionHistoryFunction({
      fetch: fetchRecordSessionHistory,
      data: id,
    }),
  );
