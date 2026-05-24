// Phase 2C — Active Teaching turn endpoint.
//
// POST /api/teaching-sessions/[id]/turn { text_md } → 200 with agent reply.
// Writes user message event, plans + writes agent reply, returns the agent.

import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import { db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { TeachingError, planTeachingTurn } from '@/server/orchestrator/teaching';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

const Body = z.object({
  text_md: z.string().min(1).max(2000),
});

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    // YUK-14 — accept both 'active' and 'idle' (inline resume on idle).
    // assertAcceptingTurns runs inside its own tx and bumps status idle→active
    // + writes conversation.resumed before returning. wasIdle propagates to
    // the response so the drawer can clear its idle banner.
    const { goalId: learningItemId, wasIdle } = await Conversation.assertAcceptingTurns(
      db,
      sessionId,
    );
    if (!learningItemId) {
      throw new ApiError(
        'invalid_state',
        'conversation session missing learning_item linkage (goal_id)',
        500,
      );
    }

    // Write user message
    const userMsgId = createId();
    await writeEvent(db, {
      id: userMsgId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:teach_message',
      subject_kind: 'event',
      subject_id: userMsgId,
      outcome: 'success',
      payload: { role: 'user', text_md: parsed.data.text_md },
    });

    // Plan + write agent reply
    try {
      const turn = await planTeachingTurn({
        db,
        sessionId,
        learningItemId,
        runTaskFn: defaultRunTaskFn,
      });
      const agentMsgId = createId();
      await writeEvent(db, {
        id: agentMsgId,
        session_id: sessionId,
        actor_kind: 'agent',
        actor_ref: 'TeachingTurnTask',
        action: 'experimental:teach_message',
        subject_kind: 'event',
        subject_id: agentMsgId,
        outcome: 'success',
        payload: { role: 'agent', text_md: turn.text_md, turn_kind: turn.kind },
        caused_by_event_id: userMsgId,
      });
      return Response.json({
        user_message: { id: userMsgId, role: 'user', text_md: parsed.data.text_md },
        agent_message: {
          id: agentMsgId,
          role: 'agent',
          text_md: turn.text_md,
          turn_kind: turn.kind,
        },
        suggested_next: turn.suggested_next,
        was_idle: wasIdle,
      });
    } catch (err) {
      if (err instanceof TeachingError) {
        const status = err.code === 'learning_item_not_found' ? 404 : 502;
        return Response.json({ error: err.code, message: err.message }, { status });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
