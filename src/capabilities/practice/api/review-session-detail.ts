import { ApiError, errorResponse } from '@/kernel/http';
import {
  readReviewSession,
  transitionReviewSession,
} from '../server/session-operations/review-session';
import { UpdateReviewSessionBody } from './contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const session = await readReviewSession(params.id);
    return Response.json(session);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Canonical target-state contract for review sessions.
 * Same-state replay is a 200 no-op; impossible transitions remain 409 conflicts.
 */
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = UpdateReviewSessionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const transition = await transitionReviewSession(params.id, parsed.data.status);
    return Response.json({
      id: params.id,
      type: 'review',
      previous_status: transition.previousStatus,
      status: transition.status,
      changed: transition.changed,
      allowed_statuses: transition.allowedStatuses,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
