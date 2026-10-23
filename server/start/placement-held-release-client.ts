import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { releaseStartHeldPlacementFunction } from './placement-held-release-function';

export const startPlacementHeldReleaseClient: PlacementClient['releaseHeldPlacement'] = async (
  sessionId,
  issuanceId,
) =>
  JSON.parse(
    await releaseStartHeldPlacementFunction({
      fetch: authenticatedStartFetch,
      data: { sessionId, body: JSON.stringify({ issuance_id: issuanceId }) },
    }),
  );
