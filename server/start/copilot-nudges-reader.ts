import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartCopilotNudges: FrontdoorContext['readCopilotNudges'] = () =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { loadActiveNudges } = await import('@/capabilities/copilot/public');
      const { db } = await import('@/db/client');
      return { nudges: await loadActiveNudges(db) };
    } catch (error) {
      throw errorResponse(error);
    }
  });
