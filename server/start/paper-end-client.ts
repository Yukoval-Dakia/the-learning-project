import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { endPaperSessionFunction } from './paper-end-function';

export const endPaperSessionClient: PracticeClient['endPaperSession'] = async (sessionId) =>
  JSON.parse(
    await endPaperSessionFunction({
      fetch: authenticatedStartFetch,
      data: sessionId,
    }),
  );
