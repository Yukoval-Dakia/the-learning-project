import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const restoreStartLibraryQuestion: FrontdoorContext['restoreLibraryQuestion'] = ({
  id,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { restorePracticeQuestion } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await restorePracticeQuestion(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
