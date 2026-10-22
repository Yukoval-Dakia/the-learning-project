import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartPapers } from './papers-list-function';

export const startPaperListClient: PracticeClient['getPapers'] = async () =>
  JSON.parse(await getStartPapers({ fetch: authenticatedStartFetch }));
