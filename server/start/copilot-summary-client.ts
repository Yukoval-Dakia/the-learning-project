import { type CopilotClient, httpCopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartCopilotSummaryFunction } from './copilot-summary-function';

export const startCopilotClient: CopilotClient = {
  ...httpCopilotClient,
  getSummary: async () =>
    JSON.parse(await getStartCopilotSummaryFunction({ fetch: authenticatedStartFetch })),
};
