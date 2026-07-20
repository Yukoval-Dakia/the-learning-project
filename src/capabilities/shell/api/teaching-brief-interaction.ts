// YUK-710 (P0F/6) — thin route shell for the append-only teaching-brief interaction ledger.
//
// POST /api/prep-desk/brief/interaction — records a `brief_seen` or a `primary_action_started`
// funnel signal. The heavy lifting (deterministic idempotency, append, mem0 opt-out) lives in
// the writer (server/teaching-brief-interactions.ts). REST status mirrors the ack route: a fresh
// append → 201 Created (+ Location); an idempotent repeat (same brief × local day, or
// brief × action_kind × local day) → 200 OK. An unparseable / malformed body → 400. This is a
// pure observational write — it never fails on the underlying brief's current state (telemetry
// must not disappear because the brief just advanced), so it does NOT re-derive the read model.

import {
  recordBriefSeen,
  recordPrimaryActionStarted,
} from '@/capabilities/shell/server/teaching-brief-interactions';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
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
