// M5-T5a (YUK-321)：平移自 app/api/events/[id]/correct/route.ts（统一事件流
// keep 行的唯一撤回 HTTP 面；裸查/rate 面退役见 Task 9「/api/events 面处置」）。
// [id] 由 toHonoPath 转 :id 捕获后以 Record 透传。

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { canonicalResourceResponse, deprecatedRouteResponse } from '@/kernel/http';
import { getEventById, writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { EventCorrectionBodySchema, EventParamsSchema } from './event-contracts';

export async function createCorrection(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const parsedParams = EventParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }
    const targetEventId = parsedParams.data.id;

    const raw = await req.json().catch(() => null);
    const parsed = EventCorrectionBodySchema.safeParse(raw);
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

export async function createCorrectionResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  return canonicalResourceResponse(await createCorrection(req, params), {
    outcome: 'created',
    location: (body) =>
      `/api/events/${encodeURIComponent(
        (body as { correction_event_id: string }).correction_event_id,
      )}`,
  });
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createCorrection(req, params);
  return deprecatedRouteResponse(response, `/api/events/${params.id}/corrections`);
}
