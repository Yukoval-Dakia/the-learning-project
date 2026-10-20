import { ApiError, errorResponse } from '@/kernel/http';
import { unresolvedField } from '../server/placement-advance';
import {
  readPlacementSession,
  transitionPlacementSession,
} from '../server/session-operations/placement-session';
import { UpdatePlacementSessionBodySchema } from './placement-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { session, starterSupply, unresolvedItems } = await readPlacementSession(params.id);
    return Response.json({
      ...session,
      starterSupply,
      ...unresolvedField(unresolvedItems),
    });
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

    const { transition, unresolvedItems } = await transitionPlacementSession(
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
      ...unresolvedField(unresolvedItems),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
