import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { readStartPaperDetailFunction } from './paper-detail-function';

export const startPaperDetailClient = async (
  artifactId: string,
): ReturnType<PracticeClient['getPaperDetail']> =>
  JSON.parse(
    await readStartPaperDetailFunction({
      fetch: authenticatedStartFetch,
      data: artifactId,
    }),
  );
