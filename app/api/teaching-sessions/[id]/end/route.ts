// Phase 2C — Active Teaching end endpoint.
//
// POST /api/teaching-sessions/[id]/end → 200 { ok: true }
// Transitions learning_session(type='conversation', status='active') → 'ended'.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await ctx.params;
    await Conversation.endConversation(db, sessionId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
