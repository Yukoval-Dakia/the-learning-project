import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartCopilotSessions: FrontdoorContext['readCopilotSessions'] = () =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readCopilotSessions } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await readCopilotSessions(db);
    } catch (error) {
      throw errorResponse(error);
    }
  });
