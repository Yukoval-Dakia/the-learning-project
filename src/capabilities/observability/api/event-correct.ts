// The only correction HTTP surface. The id arrives as a Hono param.

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
