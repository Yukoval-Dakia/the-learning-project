import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

function servingActionParams(path: string): Record<string, string> {
  const match =
    typeof path === 'string'
      ? /^\/api\/questions\/([^/?#]+)\/serving-actions\/([^/?#]+)$/.exec(path)
      : null;
  if (!match || match[0] !== path) {
    throw new ApiError(
      'validation_error',
      'expected a canonical question serving-action path',
      400,
    );
  }
  try {
    return { id: decodeURIComponent(match[1]), command: decodeURIComponent(match[2]) };
  } catch {
    throw new ApiError(
      'validation_error',
      'serving-action path contains invalid URL encoding',
      400,
    );
  }
}

export const runStartLibraryServingAction: FrontdoorContext['runLibraryServingAction'] = ({
  path,
  idempotencyKey,
}) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const params = servingActionParams(path);
      const { runPracticeServingAction } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      return await runPracticeServingAction(db, params, idempotencyKey);
    } catch (error) {
      throw errorResponse(error);
    }
  });
