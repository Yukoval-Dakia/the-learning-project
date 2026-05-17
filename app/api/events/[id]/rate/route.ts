// Generic event rating endpoint.
//
// Used by the v2.1 proposal inbox for generated content proposals
// (`generate` + `subject_kind='artifact'`). Knowledge node and edge proposals
// keep their richer domain-specific accept flows; this route records the
// generic user decision as a RateEvent chained to the target event.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { getEventById, writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const RateBody = z.object({
  rating: z.enum(['accept', 'dismiss', 'rollback']),
  user_note: z.string().max(2000).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: targetEventId } = await params;
    if (!targetEventId) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    const raw = await req.json().catch(() => null);
    const parsed = RateBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { rating, user_note } = parsed.data;

    const target = await getEventById(db, targetEventId);
    if (!target) {
      throw new ApiError('not_found', `event ${targetEventId} not found`, 404);
    }
    if (target.action === 'rate') {
      throw new ApiError('validation_error', 'rating a rate event is not supported', 400);
    }

    const existingRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'rate'),
          eq(event.subject_kind, 'event'),
          eq(event.caused_by_event_id, targetEventId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      const payload = existing.payload as { rating?: string };
      if (payload.rating !== rating) {
        throw new ApiError(
          'conflict',
          `event ${targetEventId} already rated as ${payload.rating}`,
          409,
        );
      }
      return Response.json({ rate_event_id: existing.id, idempotent: true });
    }

    const rateEventId = createId();
    await writeEvent(db, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: targetEventId,
      outcome: 'success',
      payload: {
        rating,
        ...(user_note ? { user_note } : {}),
      },
      caused_by_event_id: targetEventId,
      created_at: new Date(),
    });

    return Response.json({ rate_event_id: rateEventId, idempotent: false });
  } catch (err) {
    return errorResponse(err);
  }
}
