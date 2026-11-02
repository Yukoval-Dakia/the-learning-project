import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartCopilotSessionsFunction } from './copilot-sessions-function';

const fetchCopilotSessions: typeof fetch = (input, init) =>
  authenticatedStartFetch(input, { ...init, cache: 'no-store' });

export const startCopilotSessionsClient: CopilotClient['listSessions'] = async (signal) =>
  JSON.parse(
    await getStartCopilotSessionsFunction({
      signal,
      fetch: fetchCopilotSessions,
    }),
  );
