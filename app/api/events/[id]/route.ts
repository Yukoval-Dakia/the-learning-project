// Phase 1c.1 Step 6 — single event + its caused_by chain (forward + backward).
//
// GET /api/events/:id
//   → {
//       event: KnownEventT,
//       chain: { caused_by: KnownEventT | null, caused_events: Array<KnownEventT> }
//     }
//   → 404 when the focal event id is unknown
//
// Step 4 helper `getEventById` resolves the focal row; Step 6 helper
// `getEventChain` walks one hop in each direction (forward via the focal row's
// `caused_by_event_id` envelope field, backward via `event_caused_by_idx`).

import { db } from '@/db/client';
import { getEventById, getEventChain } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!id) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    const focal = await getEventById(db, id);
    if (focal === null) {
      throw new ApiError('not_found', `event ${id} not found`, 404);
    }

    // getEventChain re-fetches the focal row internally. Both DB reads happen
    // under db pool (no transaction); for a single-user tool the race window
    // is irrelevant.
    const chain = await getEventChain(db, id);
    return Response.json({ event: focal, chain });
  } catch (err) {
    return errorResponse(err);
  }
}
