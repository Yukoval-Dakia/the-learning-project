// POST /api/prep-desk/brief/ack route shell. A fresh ack returns 201, an idempotent
// re-ack 200; validation/ownership/idempotency live in server/teaching-brief-ack.ts.

import { acknowledgeTeachingBriefOutcome } from '@/capabilities/shell/server/teaching-brief-ack';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { TeachingBriefAckBodySchema } from './contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    // Intentional null fallback: an unparseable body is a validation failure (→ 400),
    // NOT a swallowed 500 — safeParse(null) yields a clear issue below.
    const raw = await req.json().catch(() => null);
    const parsed = TeachingBriefAckBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await acknowledgeTeachingBriefOutcome(db, parsed.data.probe_result_event_id);
    // 201 when this call created the ack, 200 when a prior ack already existed (idempotent).
    // A fresh create carries a Location to the new event (RFC 7231 §6.3.2; mirrors
    // proposal-decisions.ts); an idempotent 200 does not create, so no Location.
    const init: ResponseInit = { status: result.idempotent ? 200 : 201 };
    if (!result.idempotent) {
      init.headers = {
        Location: `/api/events/${encodeURIComponent(result.brief_acknowledgement_event_id)}`,
      };
    }
    return Response.json(result, init);
  } catch (err) {
    return errorResponse(err);
  }
}
