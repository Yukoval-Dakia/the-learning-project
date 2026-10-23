import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { submitStartPlacementAnswerFunction } from './placement-submit-function';

// Preserve the full practice body, including session, mode and accepted submission identity.
export const startPracticeSubmitClient: PracticeClient['submitReview'] = async (input) =>
  JSON.parse(
    await submitStartPlacementAnswerFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify(input),
    }),
  );
