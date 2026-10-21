// POST /api/prep-desk/brief/interaction route shell. Records one funnel signal;
// idempotency and the mem0 opt-out live in server/teaching-brief-interactions.ts.
// It never re-derives the brief, so telemetry survives the brief advancing.

import {
  recordBriefSeen,
  recordPrimaryActionStarted,
} from '@/capabilities/shell/server/teaching-brief-interactions';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { TeachingBriefInteractionBodySchema } from './contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    // Intentional null fallback: an unparseable body is a 400 validation failure, not a
    // swallowed 500 — safeParse(null) yields a clear issue below (mirrors teaching-brief-ack).
    const raw = await req.json().catch(() => null);
    const parsed = TeachingBriefInteractionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    const body = parsed.data;
    const result =
      body.type === 'brief_seen'
        ? await recordBriefSeen(db, {
            briefId: body.brief_id,
            briefState: body.brief_state,
          })
        : await recordPrimaryActionStarted(db, {
            briefId: body.brief_id,
            actionKind: body.action_kind,
            resultEventId: body.result_event_id,
            probeQuestionId: body.probe_question_id,
          });

    // 201 when this call created the row, 200 when a prior identical interaction already
    // existed (idempotent). A fresh create carries a Location to the new event (RFC 7231
    // §6.3.2; mirrors teaching-brief-ack); an idempotent 200 creates nothing, so no Location.
    const init: ResponseInit = { status: result.idempotent ? 200 : 201 };
    if (!result.idempotent) {
      init.headers = {
        Location: `/api/events/${encodeURIComponent(result.interaction_event_id)}`,
      };
    }
    return Response.json(result, init);
  } catch (err) {
    return errorResponse(err);
  }
}
