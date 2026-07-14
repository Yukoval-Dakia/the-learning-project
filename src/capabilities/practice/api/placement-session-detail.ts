import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { Placement } from '@/server/session';

const PatchBody = z.object({
  status: z.enum(['completed', 'abandoned']),
});

/** Canonical, idempotent target-state transition for a placement session. */
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(raw);
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
