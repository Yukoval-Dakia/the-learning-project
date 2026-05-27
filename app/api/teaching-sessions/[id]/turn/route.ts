// Phase 2C — Active Teaching turn endpoint.
//
// POST /api/teaching-sessions/[id]/turn { text_md } → 200 with agent reply.
// Writes user message event, plans + writes agent reply, returns the agent.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { TeachingError, planTeachingTurn } from '@/server/orchestrator/teaching';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

const Body = z.object({
  text_md: z.string().min(1).max(2000),
});

type InlineTeachingQuestion = {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
};

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
      let inlineQuestion: InlineTeachingQuestion | null = null;

      await db.transaction(async (tx) => {
        if (turn.kind === 'ask_check' && turn.structured_question) {
          const structured = turn.structured_question;
          const qId = createId();
          const liRows = await tx
            .select({ knowledge_ids: learning_item.knowledge_ids })
            .from(learning_item)
            .where(eq(learning_item.id, learningItemId))
            .limit(1);
          const knowledgeIds = liRows[0]?.knowledge_ids ?? [];
          const promptMd = structured.prompt_md ?? turn.text_md;
          const choicesMd = structured.choices_md ?? null;
          await tx.insert(question).values({
            id: qId,
            kind: structured.kind,
            prompt_md: promptMd,
            reference_md: structured.reference_md,
            rubric_json: structured.rubric_json ?? null,
            choices_md: choicesMd,
            judge_kind_override: structured.judge_kind_override ?? null,
            knowledge_ids: knowledgeIds,
            difficulty: 2,
            source: 'teaching_check',
            source_ref: agentMsgId,
            metadata: {
              learning_item_id: learningItemId,
              session_id: sessionId,
            },
            created_at: new Date(),
            updated_at: new Date(),
          });
          inlineQuestion = {
            id: qId,
            kind: structured.kind,
            prompt_md: promptMd,
            choices_md: choicesMd,
          };
        }

        const payload: {
          role: 'agent';
          text_md: string;
          turn_kind: typeof turn.kind;
          question_id?: string;
          question?: InlineTeachingQuestion;
        } = {
          role: 'agent',
          text_md: turn.text_md,
          turn_kind: turn.kind,
        };
        if (inlineQuestion) {
          payload.question_id = inlineQuestion.id;
          payload.question = inlineQuestion;
        }

        await writeEvent(tx, {
          id: agentMsgId,
          session_id: sessionId,
          actor_kind: 'agent',
          actor_ref: 'TeachingTurnTask',
          action: 'experimental:teach_message',
          subject_kind: 'event',
          subject_id: agentMsgId,
          outcome: 'success',
          payload,
          caused_by_event_id: userMsgId,
        });
      });
      return Response.json({
        user_message: { id: userMsgId, role: 'user', text_md: parsed.data.text_md },
        agent_message: {
          id: agentMsgId,
          role: 'agent',
          text_md: turn.text_md,
          turn_kind: turn.kind,
          ...(inlineQuestion ? { question: inlineQuestion } : {}),
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
