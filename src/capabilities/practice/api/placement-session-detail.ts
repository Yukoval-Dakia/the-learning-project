import { ApiError, errorResponse } from '@/kernel/http';
import {
  readPlacementSession,
  transitionPlacementSession,
} from '../server/session-operations/placement-session';
import { UpdatePlacementSessionBodySchema } from './placement-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readPlacementSession(params.id));
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

    return Response.json(await transitionPlacementSession(params.id, parsed.data.status));
  } catch (err) {
    return errorResponse(err);
  }
}
