import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  createStartHintRequestFunction,
  createStartSolveSessionFunction,
  restoreStartHintHistoryFunction,
} from './solve-function';
export const startHintHistoryClient: PracticeClient['restoreHints'] = async (
  questionId,
  issuanceId,
) =>
  JSON.parse(
    await restoreStartHintHistoryFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({ question_id: questionId, issuance_id: issuanceId }),
    }),
  );

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
  requestId,
) =>
  JSON.parse(
    await createStartHintRequestFunction({
      fetch: authenticatedStartFetch,
      data: {
        sessionId: sid,
        body: JSON.stringify({
          question_id: id,
          hint_index: hintIndex,
          issuance_id: issuanceId,
          request_id: requestId,
        }),
      },
    }),
  );
