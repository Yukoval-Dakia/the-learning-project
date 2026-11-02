import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { updateStartPracticeStreamItemFunction } from './practice-stream-item-function';

export const startPracticeStreamItemClient: PracticeClient['advanceStreamItem'] = async (
  id,
  status,
) =>
  JSON.parse(
    await updateStartPracticeStreamItemFunction({
      fetch: authenticatedStartFetch,
      data: { id, body: JSON.stringify({ status }) },
    }),
  );
