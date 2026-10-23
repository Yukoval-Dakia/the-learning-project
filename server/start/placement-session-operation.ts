import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Bound by the initialized host; the canonical operation owns transition and recovery.
export const transitionStartPlacementSession: FrontdoorContext['transitionPlacementSession'] =
  async (input) => {
    try {
      if (typeof input?.sessionId !== 'string') {
        throw new ApiError('validation_error', 'session id must be a string', 400);
      }
      const { UpdatePlacementSessionBodySchema, transitionPlacementSession } = await import(
        '@/capabilities/practice/public'
      );
      let rawBody: unknown = null;
      try {
        rawBody = JSON.parse(input.body);
      } catch {
        // Match the retained HTTP handler's malformed-JSON validation path.
      }
      const parsed = UpdatePlacementSessionBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          400,
        );
      }
      return await transitionPlacementSession(input.sessionId, parsed.data.status);
    } catch (error) {
      // Shape errors inside the host before crossing into the Start bundle.
      throw errorResponse(error);
    }
  };
