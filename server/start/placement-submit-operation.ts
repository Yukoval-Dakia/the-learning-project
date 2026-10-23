import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

// The initialized host owns submission, grading, dispatch and recovery. This adapter only
// preserves the original shared HTTP provider deadline, input contract and JSON/error projection.
export const submitStartPlacementAnswer: FrontdoorContext['submitPlacementAnswer'] = (
  body,
  signal,
) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {}
      const { CreateAttemptBodySchema, submitReviewAnswer, projectReviewAnswerResponse } =
        await import('@/capabilities/practice/public');
      const parsed = CreateAttemptBodySchema.safeParse(raw);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new ApiError('validation_error', message, 400);
      }
      const { db } = await import('@/db/client');
      const result = await submitReviewAnswer(db, parsed.data, { signal });
      return projectReviewAnswerResponse(parsed.data, result).body;
    } catch (error) {
      throw errorResponse(error);
    }
  });
