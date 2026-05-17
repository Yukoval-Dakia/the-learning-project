// Phase 2C — Active Teaching Session start endpoint.
//
// POST /api/teaching-sessions { learning_item_id } → 200 with { session_id, initial_message }
// Creates learning_session(type='conversation', status='active') and writes
// the opening agent message in the same transaction-ish boundary (event written
// after session row commits — best effort; UI gracefully retries on /turn).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { TeachingError, planTeachingTurn } from '@/server/orchestrator/teaching';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

const Body = z.object({
  learning_item_id: z.string().min(1).max(64),
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

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    // Verify learning_item exists before opening a session
    const liRows = await db
      .select({ id: learning_item.id })
      .from(learning_item)
      .where(eq(learning_item.id, parsed.data.learning_item_id))
      .limit(1);
    if (!liRows[0]) {
      throw new ApiError('not_found', 'learning_item not found', 404);
    }

    const { sessionId } = await Conversation.startConversation(db, {
      learningItemId: parsed.data.learning_item_id,
    });

    // First agent turn: plan + persist
    try {
      const turn = await planTeachingTurn({
        db,
        sessionId,
        learningItemId: parsed.data.learning_item_id,
        runTaskFn: defaultRunTaskFn,
      });
      const eventId = createId();
      await writeEvent(db, {
        id: eventId,
        session_id: sessionId,
        actor_kind: 'agent',
        actor_ref: 'TeachingTurnTask',
        action: 'experimental:teach_message',
        subject_kind: 'event',
        subject_id: eventId,
        outcome: 'success',
        payload: { role: 'agent', text_md: turn.text_md, turn_kind: turn.kind },
      });
      return Response.json({
        session_id: sessionId,
        initial_message: {
          id: eventId,
          role: 'agent',
          text_md: turn.text_md,
          turn_kind: turn.kind,
        },
        suggested_next: turn.suggested_next,
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
