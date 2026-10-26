import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const updateStartLibraryQuestion: FrontdoorContext['updateLibraryQuestion'] = ({
  id,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { updatePracticeQuestion } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await updatePracticeQuestion(db, { id }, async () => JSON.parse(body));
    } catch (error) {
      throw errorResponse(error);
    }
  });
