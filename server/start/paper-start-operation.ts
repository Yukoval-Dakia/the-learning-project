import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const startPaperSession: FrontdoorContext['startPaperSession'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { createReviewSession } = await import('@/capabilities/practice/public');
      const { sessionId } = await createReviewSession(body);
      return { session_id: sessionId };
    } catch (error) {
      throw errorResponse(error);
    }
  });
