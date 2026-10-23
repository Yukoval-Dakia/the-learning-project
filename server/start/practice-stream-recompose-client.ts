import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { recomposeStartPracticeStreamFunction } from './practice-stream-recompose-function';

export const startPracticeRecomposeClient: PracticeClient['recomposeStream'] = async () =>
  JSON.parse(
    await recomposeStartPracticeStreamFunction({
      fetch: authenticatedStartFetch,
    }),
  );
