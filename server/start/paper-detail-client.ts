import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { readStartPaperDetailFunction } from './paper-detail-function';

export const startPaperDetailClient: PracticeClient['getPaperDetail'] = async (artifactId) =>
  JSON.parse(
    await readStartPaperDetailFunction({
      fetch: authenticatedStartFetch,
      data: artifactId,
    }),
  );
