import {
  type RecordClient,
  projectSessionBlocksResponse,
} from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartRecordBlocksFunction } from './record-blocks-function';

export const startRecordBlocksClient: RecordClient['listBlocks'] = async (id) =>
  projectSessionBlocksResponse(
    JSON.parse(
      await getStartRecordBlocksFunction({
        fetch: authenticatedStartFetch,
        data: id,
      }),
    ),
  );
