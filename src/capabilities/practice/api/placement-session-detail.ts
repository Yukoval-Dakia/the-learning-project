import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { Placement } from '@/server/session';
import { UpdatePlacementSessionBodySchema } from './placement-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db
      .select({
        id: learning_session.id,
        type: learning_session.type,
        status: learning_session.status,
        goal_id: learning_session.goal_id,
        scope_knowledge_ids: learning_session.scope_knowledge_ids,
        started_at: learning_session.started_at,
        ended_at: learning_session.ended_at,
        updated_at: learning_session.updated_at,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, params.id), eq(learning_session.type, 'placement')))
      .limit(1);
    const session = rows[0];
    if (!session) {
      throw new ApiError('not_found', `placement session ${params.id} not found`, 404);
    }
    return Response.json(session);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Canonical, idempotent target-state transition for a placement session. */
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = UpdatePlacementSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const transition = await Placement.transitionPlacementSession(
      db,
      params.id,
      parsed.data.status,
    );
    return Response.json({
      id: params.id,
      type: 'placement',
      previous_status: transition.previousStatus,
      status: transition.status,
      changed: transition.changed,
      allowed_statuses: transition.allowedStatuses,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
