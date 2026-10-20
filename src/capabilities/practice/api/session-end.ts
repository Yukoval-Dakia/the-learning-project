// ADR-0013 — end review session via explicit close OR sendBeacon on pagehide.
//
// sendBeacon sends Content-Type: text/plain by default; we accept any body and
// only parse if Content-Type is JSON, defaulting to status='completed'.

import type { z } from 'zod';

import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { closeReviewSession } from '../server/session-operations/review-session';
import { EndReviewSessionBodySchema } from './contracts';

// Compatibility export: the summary-dispatch contract lives in
// server/session-operations/review-session.ts now; importers on this path
// keep working unchanged.
export { enqueueReviewSessionSummary } from '../server/session-operations/review-session';

async function parseBody(req: Request): Promise<z.infer<typeof EndReviewSessionBodySchema>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const raw = await req.json().catch(() => ({}));
    const parsed = EndReviewSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }
    return parsed.data;
  }
  // sendBeacon default: text/plain or other — interpret as completed.
  // Try parsing as JSON anyway in case the client sent JSON without setting the
  // header (sendBeacon Blob with type='application/json' is the explicit way).
  const text = await req.text().catch(() => '');
  if (text.length > 0) {
    try {
      const json = JSON.parse(text);
      const parsed = EndReviewSessionBodySchema.safeParse(json);
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to default
    }
  }
  return { status: 'completed' };
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    const { id } = params;
    const body = await parseBody(req);
    await closeReviewSession(id, body.status);
    response = Response.json({ ok: true, status: body.status });
  } catch (err) {
    response = errorResponse(err);
  }
  return deprecatedRouteResponse(response, `/api/review-sessions/${params.id}`);
}
