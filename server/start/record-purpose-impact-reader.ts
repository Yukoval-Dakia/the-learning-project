import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartRecordPurposeImpact: FrontdoorContext['readRecordPurposeImpact'] = ({
  sessionId,
  query,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { requestPurposeImpact } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await requestPurposeImpact(
        db,
        { id: sessionId },
        Object.fromEntries(new URLSearchParams(query)),
      );
    } catch (error) {
      throw errorResponse(error);
    }
  });
