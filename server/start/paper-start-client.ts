import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { startPaperSessionFunction } from './paper-start-function';

export const startPaperSessionClient: PracticeClient['startPaperSession'] = async (artifactId) =>
  JSON.parse(
    await startPaperSessionFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({ paper_id: artifactId }),
    }),
  );
