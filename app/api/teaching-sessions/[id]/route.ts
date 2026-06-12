// Phase 2C — Active Teaching Session detail endpoint.
//
// GET /api/teaching-sessions/[id] → 200 { session, messages } | 404
// Returns conversation session metadata + ordered message list (experimental:
// teach_message events for the session).

import { asc, eq } from 'drizzle-orm';

import { getActiveQuestionState } from '@/capabilities/copilot/server/teaching/active-question';
import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await ctx.params;

    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId))
      .limit(1);
    const session = sessionRows[0];
    if (!session || session.type !== 'conversation') {
      throw new ApiError('not_found', `conversation session ${sessionId} not found`, 404);
    }

    const eventRows = await db
      .select({
        id: event.id,
        actor_kind: event.actor_kind,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(eq(event.session_id, sessionId))
      .orderBy(asc(event.created_at));
    const messages = eventRows
      .map((r) => {
        const p = r.payload as { role?: string; text_md?: string; turn_kind?: string } | null;
        if (!p?.role || !p.text_md) return null;
        return {
          id: r.id,
          role: p.role,
          text_md: p.text_md,
          turn_kind: p.turn_kind ?? null,
          created_at: r.created_at,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    // P5.6 / YUK-178 (call-site 11, §4.3, PIN 8) — surface the active question id
    // + its cumulative attempt_counts so the drawer can drive the corrective
    // redo chip without a DB column. The GET poll is the PRIMARY source: the
    // failure total is non-zero only after an attempt lands, which the periodic
    // poll observes (the turn-response value is a convenience, not the trigger).
    const { active_question_id, attempt_counts } = await getActiveQuestionState(db, sessionId);

    return Response.json({
      session: {
        id: session.id,
        type: session.type,
        status: session.status,
        learning_item_id: session.goal_id,
        started_at: session.started_at,
        ended_at: session.ended_at,
      },
      messages,
      active_question_id,
      attempt_counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
