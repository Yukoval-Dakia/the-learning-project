import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartHintRequestFunction, createStartSolveSessionFunction } from './solve-function';

export const startSolveClient: PracticeClient['solveStart'] = async (id, issuanceId) =>
  JSON.parse(
    await createStartSolveSessionFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({ question_id: id, issuance_id: issuanceId }),
    }),
  );

export const startHintClient: PracticeClient['solveHint'] = async (
  id,
  sid,
  hintIndex,
  issuanceId,
) =>
  JSON.parse(
    await createStartHintRequestFunction({
      fetch: authenticatedStartFetch,
      data: {
        sessionId: sid,
        body: JSON.stringify({ question_id: id, hint_index: hintIndex, issuance_id: issuanceId }),
      },
    }),
  );
