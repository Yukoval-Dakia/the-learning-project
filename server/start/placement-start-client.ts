import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartPlacementFunction } from './placement-start-function';

export const startPlacementStartClient: PlacementClient['startPlacement'] = async (
  goalId,
  selfReport = {},
) =>
  JSON.parse(
    await createStartPlacementFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({
        goalId,
        ...(selfReport.leanings && selfReport.leanings.length > 0
          ? { leanings: selfReport.leanings }
          : {}),
        ...(selfReport.pace ? { pace: selfReport.pace } : {}),
      }),
    }),
  );
