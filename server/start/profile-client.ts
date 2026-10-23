import type { PlacementProfileClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartPlacementProfile } from './profile-function';

export const startPlacementProfileClient: PlacementProfileClient['getPlacementProfile'] = async (
  goalId,
) => JSON.parse(await getStartPlacementProfile({ fetch: authenticatedStartFetch, data: goalId }));
