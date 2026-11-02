import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const startPaperSession: FrontdoorContext['startPaperSession'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = {};
      if (body.trim()) {
        try {
          raw = JSON.parse(body);
        } catch {
          throw new ApiError('validation_error', 'request body must be valid JSON', 400);
        }
      }
      const { CreateReviewSessionBody, createReviewSession } = await import(
        '@/capabilities/practice/public'
      );
      const parsed = CreateReviewSessionBody.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues.map((issue) => issue.message).join('; '),
          400,
        );
      }
      const { sessionId } = await createReviewSession({ paperId: parsed.data.paper_id });
      return { session_id: sessionId };
    } catch (error) {
      throw errorResponse(error);
    }
  });
