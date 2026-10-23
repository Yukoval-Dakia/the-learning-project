import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const updateStartPracticeStreamItem: FrontdoorContext['updatePracticeStreamItem'] = ({
  id,
  body,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {
        // Preserve the HTTP adapter's malformed-JSON input to the shared schema.
      }
      const { updatePracticeStreamItem } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await updatePracticeStreamItem(db, id, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
