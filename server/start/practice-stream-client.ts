import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartPracticeStreamFunction } from './practice-stream-function';

export const startPracticeStreamClient: PracticeClient['getStream'] = async (knowledgeId) =>
  JSON.parse(
    await getStartPracticeStreamFunction({
      fetch: authenticatedStartFetch,
      data: knowledgeId?.trim() || undefined,
    }),
  );
