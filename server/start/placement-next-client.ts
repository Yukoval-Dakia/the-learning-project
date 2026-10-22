import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { selectStartPlacementQuestionFunction } from './placement-next-function';

export const startPlacementNextClient: PlacementClient['placementNext'] = async (sessionId) =>
  JSON.parse(
    await selectStartPlacementQuestionFunction({ fetch: authenticatedStartFetch, data: sessionId }),
  );
