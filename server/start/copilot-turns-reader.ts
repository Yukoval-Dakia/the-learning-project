import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartCopilotTurns: FrontdoorContext['readCopilotTurns'] = (query) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readCopilotTurns } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return await readCopilotTurns(db, new URLSearchParams(query));
    } catch (error) {
      throw errorResponse(error);
    }
  });
