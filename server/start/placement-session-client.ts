import { type PlacementClient, httpPlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  getStartPlacementSession,
  updateStartPlacementSession,
} from './placement-session-function';

export const startPlacementSessionClient: PlacementClient['getPlacementSession'] = async (
  sessionId,
) =>
  JSON.parse(await getStartPlacementSession({ fetch: authenticatedStartFetch, data: sessionId }));

export const startPlacementEndClient: PlacementClient['placementEnd'] = async (
  sessionId,
  status = 'completed',
  options = {},
) => {
  if (options.keepalive === true) {
    return httpPlacementClient.placementEnd(sessionId, status, options);
  }
  return JSON.parse(
    await updateStartPlacementSession({
      fetch: authenticatedStartFetch,
      data: { sessionId, body: JSON.stringify({ status }) },
    }),
  );
};
