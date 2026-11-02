import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { revealStartStudyReferenceFunction } from './study-reference-function';

export const startStudyReferenceClient: PracticeClient['revealStudyReference'] = async (
  issuanceId,
) =>
  JSON.parse(
    await revealStartStudyReferenceFunction({
      fetch: authenticatedStartFetch,
      data: issuanceId,
    }),
  );
