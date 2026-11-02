import { type CopilotClient, buildCopilotTurnsQuery } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartCopilotTurnsFunction } from './copilot-turns-function';

export const startCopilotTurnsClient: CopilotClient['listTurns'] = async (sessionId, limit) =>
  JSON.parse(
    await getStartCopilotTurnsFunction({
      fetch: authenticatedStartFetch,
      data: buildCopilotTurnsQuery(sessionId, limit),
    }),
  );
