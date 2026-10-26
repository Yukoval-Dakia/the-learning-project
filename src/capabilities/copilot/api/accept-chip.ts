// POST /api/teaching-sessions/[id]/accept-chip
// Writes `action:'accept_suggestion'` for a chip click. A corrective chip-accept
// is still a full event; only the KPI reader excludes it.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { acceptTeachingChip } from '../server/accept-teaching-chip';
import { AcceptTeachingChipBodySchema, CopilotRouteIdParamsSchema } from './contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: sessionId } = CopilotRouteIdParamsSchema.parse(params);
    const raw = await req.json().catch(() => null);
    const parsed = AcceptTeachingChipBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    const outcome = await acceptTeachingChip(db, sessionId, parsed.data);

    return Response.json({ ok: true, event_id: outcome.eventId });
  } catch (err) {
    return errorResponse(err);
  }
}
