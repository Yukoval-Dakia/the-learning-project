// Thin-create subject endpoint. The server module owns the transaction and
// idempotency; this layer only parses the body and maps the write result to HTTP.

import { z } from 'zod';
import { db } from '@/db/client';
import { errorResponse, resourceResponse } from '@/kernel/http';
import { thinCreateSubject } from '../public';

const Body = z.object({ displayName: z.string() });

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'displayName (string) is required' }, { status: 400 });
    }
    const result = await thinCreateSubject(db, parsed.data.displayName);
    switch (result.kind) {
      case 'created':
        return resourceResponse(result.payload, {
          outcome: 'created',
          location: `/api/admin/subjects/${encodeURIComponent(result.payload.id)}`,
        });
      case 'replayed':
        return resourceResponse(result.payload, {
          outcome: 'existing',
          location: `/api/admin/subjects/${encodeURIComponent(result.payload.id)}`,
        });
      case 'invalid':
        return Response.json({ error: result.message }, { status: 400 });
      case 'name_conflict':
        return Response.json({ error: result.message }, { status: 422 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
