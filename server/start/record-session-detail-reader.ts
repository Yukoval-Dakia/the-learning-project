import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartRecordSessionDetail: FrontdoorContext['readRecordSessionDetail'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionDetail } = await import('@/capabilities/ingestion/public');
      return await readIngestionSessionDetail(id);
    } catch (error) {
      throw errorResponse(error);
    }
  });
