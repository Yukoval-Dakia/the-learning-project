import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartRecordBlocks: FrontdoorContext['readRecordBlocks'] = (id) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readIngestionSessionBlocks } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readIngestionSessionBlocks(db, { id });
    } catch (error) {
      throw errorResponse(error);
    }
  });
