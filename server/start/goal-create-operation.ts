import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// Subject normalization and goal materialization use the initialized host registry/Db.
export const createStartGoal: FrontdoorContext['createGoal'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new ApiError('validation_error', 'request body must be valid JSON', 400);
      }
      const { createGoal } = await import('@/capabilities/agency/public');
      const { db } = await import('@/db/client');
      return await createGoal(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
