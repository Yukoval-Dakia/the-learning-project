import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// The initialized host owns parsing, submission, grading, dispatch and recovery. This adapter
// only preserves the original shared HTTP provider deadline and JSON/error projection.
export const submitStartPlacementAnswer: FrontdoorContext['submitPlacementAnswer'] = (
  body,
  signal,
) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestReviewAnswer } = await import('@/capabilities/practice/grading/public');
      const { db } = await import('@/db/client');
      return (await requestReviewAnswer(db, async () => JSON.parse(body), { signal })).body;
    } catch (error) {
      throw errorResponse(error);
    }
  });
