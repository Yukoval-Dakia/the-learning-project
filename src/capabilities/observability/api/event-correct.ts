// M5-T5a (YUK-321)：平移自 app/api/events/[id]/correct/route.ts（统一事件流
// keep 行的唯一撤回 HTTP 面；裸查/rate 面退役见 Task 9「/api/events 面处置」）。
// [id] 由 toHonoPath 转 :id 捕获后以 Record 透传。

import { db } from '@/db/client';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { createEventCorrection } from '../server/event-detail';
import { EventCorrectionResponseSchema, EventParamsSchema } from './event-contracts';

export async function createCorrection(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const parsedParams = EventParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }
    const raw = await req.json().catch(() => null);
    return Response.json(await createEventCorrection(db, parsedParams.data.id, raw));
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
        EventCorrectionResponseSchema.parse(body).correction_event_id,
      )}`,
  });
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createCorrection(req, params);
  return deprecatedRouteResponse(response, `/api/events/${params.id}/corrections`);
}
