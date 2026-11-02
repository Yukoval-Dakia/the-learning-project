import {
  type RecordClient,
  projectRecordSessionDetailResponse,
} from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartRecordSessionDetailFunction } from './record-session-detail-function';

const fetchRecordSessionDetail: typeof fetch = (input, init) =>
  authenticatedStartFetch(input, { ...init, cache: 'no-store' });

export const startRecordSessionDetailClient: RecordClient['getSession'] = async (id) =>
  projectRecordSessionDetailResponse(
    JSON.parse(
      await getStartRecordSessionDetailFunction({
        fetch: fetchRecordSessionDetail,
        data: id,
      }),
    ),
  );
