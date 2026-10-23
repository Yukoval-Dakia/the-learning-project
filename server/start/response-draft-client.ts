import { type PlacementClient, httpPlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { saveStartResponseDraftFunction } from './response-draft-function';

export const startResponseDraftClient: PlacementClient['saveResponseDraft'] = async (
  issuanceId,
  body,
  options = {},
) => {
  if (options.keepalive === true) {
    return httpPlacementClient.saveResponseDraft(issuanceId, body, options);
  }
  return JSON.parse(
    await saveStartResponseDraftFunction({
      fetch: authenticatedStartFetch,
      data: { issuanceId, body: JSON.stringify(body) },
    }),
  );
};
