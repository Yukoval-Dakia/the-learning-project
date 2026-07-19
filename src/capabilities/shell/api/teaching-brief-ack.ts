// YUK-708 (P0F/4) — thin route shell for the append-only teaching-brief outcome ack.
//
// POST /api/prep-desk/brief/ack — the "知道了" that retires a delivered outcome. The
// heavy lifting (target validation, idempotency, single append) lives in the writer
// (server/teaching-brief-ack.ts). REST status (mirrors proposal-decisions.ts): a fresh
// ack → 201 Created; an idempotent re-ack → 200 OK. Honest failures: an unparseable/missing
// body → 400; a non-result target → 404; not the current primary outcome → 409; a corrupt
// ack payload → 500. The UI keeps the current brief and offers a retry (contract §7).

import { acknowledgeTeachingBriefOutcome } from '@/capabilities/shell/server/teaching-brief-ack';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
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
    return Response.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
