import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartLibraryQuestionDetail: FrontdoorContext['readLibraryQuestionDetail'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readQuestionDetail } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await readQuestionDetail(db, { id }, { timelineLimit: null, surface: null });
    } catch (error) {
      throw errorResponse(error);
    }
  });
