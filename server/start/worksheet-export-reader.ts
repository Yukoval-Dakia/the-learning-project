import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartWorksheetExport: FrontdoorContext['readWorksheetExport'] = (token) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readWorksheetExport } = await import('@/capabilities/practice/session/public');
      const { db } = await import('@/db/client');
      const state = await readWorksheetExport(db, token);
      if (!state) {
        throw new ApiError('not_found', `worksheet export '${token}' not found`, 404);
      }
      return state;
    } catch (error) {
      throw errorResponse(error);
    }
  });
