import {
  type RecordClient,
  projectPurposeImpact,
  purposeImpactUrl,
} from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartRecordPurposeImpactFunction } from './record-purpose-impact-function';

const fetchPurposeImpact: typeof fetch = (input, init) =>
  authenticatedStartFetch(input, { ...init, cache: 'no-store' });

export const startRecordPurposeImpactClient: RecordClient['getPurposeImpact'] = async (
  id,
  requestId,
  location,
) => {
  const [, query = ''] = purposeImpactUrl(id, requestId, location).split('?');
  return projectPurposeImpact(
    id,
    JSON.parse(
      await getStartRecordPurposeImpactFunction({
        fetch: fetchPurposeImpact,
        data: { sessionId: id, query },
      }),
    ),
  );
};
