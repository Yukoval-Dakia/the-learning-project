import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartPaperDetail: FrontdoorContext['readPaperDetail'] = (artifactId) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { getPaperDetail } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      const result = await getPaperDetail(db, artifactId);
      if (!result) {
        throw new ApiError('not_found', `paper artifact ${artifactId} not found`, 404);
      }
      return result;
    } catch (error) {
      throw errorResponse(error);
    }
  });
