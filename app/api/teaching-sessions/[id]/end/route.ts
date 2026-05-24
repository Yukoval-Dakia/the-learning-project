// Phase 2C / YUK-14 — Active Teaching end endpoint.
//
// POST /api/teaching-sessions/[id]/end with { status: 'ended' | 'abandoned' }
// → 200 { ok: true, status }. Default = 'ended' (drawer unmount, explicit
// close). sendBeacon Content-Type defaults to text/plain; we accept any body
// type and try to parse JSON from the raw text, mirror of the /review end
// route (ADR-0013).
//
// design SoT: docs/design/2026-05-24-teaching-idle-state-machine.md
// §"Pagehide / sendBeacon" — drawer that was already showing the idle banner
// sends status='abandoned' (user walked off + closed tab); active drawer
// sends 'ended'.

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

const EndBody = z.object({
  status: z.enum(['ended', 'abandoned']).default('ended'),
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
  // sendBeacon default: text/plain or other — try parsing as JSON; fall back
  // to default 'ended'.
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
  return { status: 'ended' };
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await ctx.params;
    const body = await parseBody(req);
    if (body.status === 'ended') {
      await Conversation.endConversation(db, sessionId);
    } else {
      await Conversation.abandonConversation(db, sessionId, 'pagehide_idle');
    }
    return Response.json({ ok: true, status: body.status });
  } catch (err) {
    return errorResponse(err);
  }
}
