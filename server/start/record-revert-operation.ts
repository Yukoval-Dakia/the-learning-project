import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const revertStartRecordBlock: FrontdoorContext['revertRecordBlock'] = ({
  sessionId,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        raw = null;
      }
      const { revertIngestionBlock } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await revertIngestionBlock(db, sessionId, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
