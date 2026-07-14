import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { Review } from '@/server/session';
import { UpdateReviewSessionBody } from './contracts';
import { enqueueReviewSessionSummary } from './session-end';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db
      .select({
        id: learning_session.id,
        type: learning_session.type,
        status: learning_session.status,
        paper_id: learning_session.artifact_id,
        started_at: learning_session.started_at,
        ended_at: learning_session.ended_at,
        updated_at: learning_session.updated_at,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, params.id), eq(learning_session.type, 'review')))
      .limit(1);
    const session = rows[0];
    if (!session) {
      throw new ApiError('not_found', `review session ${params.id} not found`, 404);
    }
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

    const transition = await Review.transitionReviewSession(db, params.id, parsed.data.status);
    if (transition.changed && transition.status === 'completed') {
      await enqueueReviewSessionSummary(params.id);
    }
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
