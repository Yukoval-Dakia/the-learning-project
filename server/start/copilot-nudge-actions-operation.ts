import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const dismissStartCopilotNudge: FrontdoorContext['dismissCopilotNudge'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { dismissCopilotNudge } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await dismissCopilotNudge(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const markStartCopilotNudgeOpened: FrontdoorContext['markCopilotNudgeOpened'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { markCopilotNudgeOpened } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await markCopilotNudgeOpened(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });
