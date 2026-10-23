import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const endStartPaperSession: FrontdoorContext['endPaperSession'] = (sessionId) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { transitionReviewSession } = await import('@/capabilities/practice/public');
      const transition = await transitionReviewSession(sessionId, 'completed');
      return {
        id: sessionId,
        type: 'review',
        previous_status: transition.previousStatus,
        status: transition.status,
        changed: transition.changed,
        allowed_statuses: transition.allowedStatuses,
      } satisfies Awaited<ReturnType<FrontdoorContext['endPaperSession']>>;
    } catch (error) {
      throw errorResponse(error);
    }
  });
