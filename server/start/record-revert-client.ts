import type { RecordClient } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { revertStartRecordBlockFunction } from './record-revert-function';

export const startRecordRevertClient: RecordClient['revertBlock'] = async (sessionId, blockId) => {
  await revertStartRecordBlockFunction({
    fetch: authenticatedStartFetch,
    data: { sessionId, body: JSON.stringify({ block_id: blockId }) },
  });
};
