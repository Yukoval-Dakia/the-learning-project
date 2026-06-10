// ADR-0013 — end review session via explicit close OR sendBeacon on pagehide.
//
// sendBeacon sends Content-Type: text/plain by default; we accept any body and
// only parse if Content-Type is JSON, defaulting to status='completed'.

import { z } from 'zod';

import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Review } from '@/server/session';

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
  // sendBeacon default: text/plain or other — interpret as completed.
  // Try parsing as JSON anyway in case the client sent JSON without setting the
  // header (sendBeacon Blob with type='application/json' is the explicit way).
  const text = await req.text().catch(() => '');
  if (text.length > 0) {
    try {
      const json = JSON.parse(text);
      const parsed = EndBody.safeParse(json);
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to default
    }
  }
  return { status: 'completed' };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = await parseBody(req);
    if (body.status === 'completed') {
      await Review.completeReviewSession(db, id);
      // Enqueue async SessionSummaryTask (Phase 1d). Best-effort: if pg-boss
      // is down the session still closes successfully and summary stays null
      // (the /learning-sessions/[id] UI shows a stub in that case).
      //
      // Skipped in tests via the shared shouldEnqueueBackgroundJobs() (YUK-239)
      // — the singleton boss instance + per-route invocation bloats the
      // testcontainer's connection pool past max_connections, tipping over
      // src/server/boss/client.test.ts. The summary handler is covered by its
      // own unit test (src/server/session/summary.test.ts).
      if (shouldEnqueueBackgroundJobs()) {
        try {
          const boss = await getStartedBoss();
          await boss.send('session_summary', { session_id: id });
        } catch (err) {
          console.warn(`session_summary enqueue failed for ${id}:`, err);
        }
      }
    } else {
      await Review.abandonReviewSession(db, id);
    }
    return Response.json({ ok: true, status: body.status });
  } catch (err) {
    return errorResponse(err);
  }
}
