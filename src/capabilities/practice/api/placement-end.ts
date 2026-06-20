// POST /api/placement/[id]/end — cold-start inc-B (YUK-468, PR-2b).
//
// Closes a placement probe: status='completed' (hit a termination condition) or 'abandoned'
// (walked away). Mirrors the review session-end handler (sendBeacon-tolerant body parse).

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Placement } from '@/server/session';

const EndBody = z.object({
  status: z.enum(['completed', 'abandoned']).default('completed'),
});

async function parseBody(req: Request): Promise<z.infer<typeof EndBody>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const raw = await req.json().catch(() => ({}));
    const parsed = EndBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }
    return parsed.data;
  }
  // sendBeacon default (text/plain or other) → interpret as completed; try JSON-in-text anyway.
  const text = await req.text().catch(() => '');
  if (text.length > 0) {
    try {
      const parsed = EndBody.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to default
    }
  }
  return { status: 'completed' };
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;
    const body = await parseBody(req);
    if (body.status === 'completed') {
      await Placement.completePlacementSession(db, id);
    } else {
      await Placement.abandonPlacementSession(db, id);
    }
    return Response.json({ ok: true, status: body.status });
  } catch (err) {
    return errorResponse(err);
  }
}
