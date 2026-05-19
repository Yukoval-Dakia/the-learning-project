import { newId } from '@/core/ids';
import { ActivityRef } from '@/core/schema/activity';
import { db } from '@/db/client';
import { getEventById, writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { z } from 'zod';

export const runtime = 'nodejs';

const CorrectBody = z
  .object({
    correction_kind: z.enum(['supersede', 'retract', 'mark_wrong', 'restore']),
    replacement_event_id: z.string().min(1).optional(),
    reason_md: z.string().trim().min(1),
    affected_refs: z.array(ActivityRef).min(1),
  })
  .superRefine((data, ctx) => {
    if (data.correction_kind === 'supersede' && !data.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is required when correction_kind='supersede'",
        path: ['replacement_event_id'],
      });
    }
  });

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: targetEventId } = await params;
    if (!targetEventId) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    const raw = await req.json().catch(() => null);
    const parsed = CorrectBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    const target = await getEventById(db, targetEventId);
    if (!target) {
      throw new ApiError('not_found', `event ${targetEventId} not found`, 404);
    }

    const payload = parsed.data;
    const correctionEventId = newId();
    await writeEvent(db, {
      id: correctionEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: targetEventId,
      outcome: 'success',
      payload,
      caused_by_event_id: targetEventId,
      created_at: new Date(),
    });

    return Response.json({ correction_event_id: correctionEventId });
  } catch (err) {
    return errorResponse(err);
  }
}
