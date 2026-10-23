import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartPracticeAppeal: FrontdoorContext['createPracticeAppeal'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { createPracticeAppeal } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      const response = await createPracticeAppeal(db, async () => JSON.parse(body));
      if (!response.ok) throw response;
      return await response.text();
    } catch (error) {
      throw error instanceof Response ? error : errorResponse(error);
    }
  });
