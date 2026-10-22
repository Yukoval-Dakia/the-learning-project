import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// Resolve the complete operation in the initialized host graph after authentication.
// Preserve the HTTP scope; cold starter dispatch and worker budgets remain owner-managed.
export const createStartPlacement: FrontdoorContext['startPlacement'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { CreatePlacementSessionBodySchema, startPlacementProbe } = await import(
        '@/capabilities/practice/public'
      );
      return await startPlacementProbe(async () => {
        // The existing placement flag gate must run before body parsing/validation.
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          throw new ApiError('validation_error', 'request body must be valid JSON', 400);
        }
        const parsed = CreatePlacementSessionBodySchema.safeParse(raw);
        if (!parsed.success) {
          throw new ApiError(
            'validation_error',
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            400,
          );
        }
        return parsed.data;
      });
    } catch (error) {
      throw errorResponse(error);
    }
  });
