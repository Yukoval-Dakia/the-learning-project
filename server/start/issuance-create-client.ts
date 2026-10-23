import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartIssuanceFunction } from './issuance-create-function';

export const startIssuanceCreateClient: PracticeClient['issueAssessment'] = async (input) =>
  JSON.parse(
    await createStartIssuanceFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify(input),
    }),
  );
