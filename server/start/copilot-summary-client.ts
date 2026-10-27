import { type CopilotClient, httpCopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  dismissStartCopilotNudgeFunction,
  markStartCopilotNudgeOpenedFunction,
} from './copilot-nudge-actions-function';
import { getStartCopilotNudgesFunction } from './copilot-nudges-function';
import { getStartCopilotSummaryFunction } from './copilot-summary-function';

export const startCopilotClient: CopilotClient = {
  ...httpCopilotClient,
  dismissNudge: async (id) => {
    await dismissStartCopilotNudgeFunction({ fetch: authenticatedStartFetch, data: { id } });
  },
  markNudgeOpened: async (id) => {
    await markStartCopilotNudgeOpenedFunction({ fetch: authenticatedStartFetch, data: { id } });
  },
  getNudges: async () =>
    JSON.parse(await getStartCopilotNudgesFunction({ fetch: authenticatedStartFetch })),
  getSummary: async () =>
    JSON.parse(await getStartCopilotSummaryFunction({ fetch: authenticatedStartFetch })),
};
