// Single-event read: parsing, correction state and the one-hop chain reuse the event
// owner's reader rather than reimplementing query semantics here.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readEventDetail } from '../server/event-detail';
import { EventParamsSchema } from './event-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = EventParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    return Response.json(await readEventDetail(db, parsed.data.id));
  } catch (error) {
    return errorResponse(error);
  }
}
