import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartLibraryDraftDetail: FrontdoorContext['readLibraryDraftDetail'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readDraftReviewDetail } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await readDraftReviewDetail(db, id);
    } catch (error) {
      throw errorResponse(error);
    }
  });
