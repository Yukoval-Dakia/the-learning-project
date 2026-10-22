import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartPlacementSession } from './placement-session-function';

export const startPlacementSessionClient: PlacementClient['getPlacementSession'] = async (
  sessionId,
) =>
  JSON.parse(await getStartPlacementSession({ fetch: authenticatedStartFetch, data: sessionId }));
