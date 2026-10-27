import { type CopilotClient, httpCopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartCopilotNudgesFunction } from './copilot-nudges-function';
import { getStartCopilotSummaryFunction } from './copilot-summary-function';

export const startCopilotClient: CopilotClient = {
  ...httpCopilotClient,
  getNudges: async () =>
    JSON.parse(await getStartCopilotNudgesFunction({ fetch: authenticatedStartFetch })),
  getSummary: async () =>
    JSON.parse(await getStartCopilotSummaryFunction({ fetch: authenticatedStartFetch })),
};
