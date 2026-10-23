import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartIssuanceState } from './issuance-state-function';

export const startIssuanceStateClient: PracticeClient['getIssuanceState'] = async (issuanceId) =>
  JSON.parse(await getStartIssuanceState({ fetch: authenticatedStartFetch, data: issuanceId }));
