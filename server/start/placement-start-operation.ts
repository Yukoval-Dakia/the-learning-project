import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// Resolve the complete operation in the initialized host graph after authentication.
// Preserve the HTTP scope; the flag gate, body parsing, cold starter dispatch and worker
// budgets remain owner-managed.
export const createStartPlacement: FrontdoorContext['startPlacement'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { startPlacementProbe } = await import('@/capabilities/practice/placement/public');
      return await startPlacementProbe(async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
