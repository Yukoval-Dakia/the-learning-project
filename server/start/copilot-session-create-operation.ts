import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartCopilotSession: FrontdoorContext['createCopilotSession'] = () =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { createCopilotSession } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await createCopilotSession(db);
    } catch (error) {
      throw errorResponse(error);
    }
  });
