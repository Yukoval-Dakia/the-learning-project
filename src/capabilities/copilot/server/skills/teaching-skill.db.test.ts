// AF S4 / YUK-203 U6 (OQ2/OQ7/OQ9, R2 — single-session) — teaching-skill DB tests.
//
// A teaching turn inside Copilot lives ENTIRELY on the Copilot session:
//   - ask_check turns return a pendingQuestion (NOT yet persisted — the caller,
//     runCopilotChat, wraps the question INSERT + reply event in one transaction
//     for atomicity; PR #305 review comment #1).
//   - the materialized question is stamped with the Copilot session id as provenance.
//   - NO second learning_session row is created by the skill.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { materializeAskCheckQuestion } from '@/capabilities/copilot/server/teaching/materialize-ask-check';
import { event, learning_item, learning_session, question } from '@/db/schema';
import { Conversation } from '@/server/session';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { writeCopilotInputEvent, writeTeachingCopilotReply } from '../chat';
import { runTeachingSkill } from './teaching-skill';

const db = testDb();

async function seedLearningItem(id: string): Promise<void> {
  const now = new Date();
  await db.insert(learning_item).values({
    id,
    source: 'manual',
    title: '虚词「之」',
    content: '理解「之」的代词用法',
    knowledge_ids: [],
    child_learning_item_ids: [],
    status: 'pending',
    user_pinned: false,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// A real Copilot conversation session (entrypoint='copilot', goal_id=null).
async function seedCopilotSession(): Promise<string> {
  const { sessionId } = await Conversation.findOrCreateCopilotConversation(db);
  return sessionId;
}

describe('runTeachingSkill (U6 teaching skill — single session)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('explain turn: returns text + kind, returns no pendingQuestion', async () => {
    await seedLearningItem('li_skill_explain');
    const sessionId = await seedCopilotSession();
    const controller = new AbortController();
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_t1',
      text: JSON.stringify({
        kind: 'explain',
        text_md: '我们先看这段。',
        suggested_next: 'continue',
      }),
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));

    const result = await runTeachingSkill(
      {
        db,
        sessionId,
        learningItemId: 'li_skill_explain',
        userMessage: '帮我讲讲',
        providerSessionDeadlineAt: 456_789,
        taskRunId: 'conversation_attempt_teaching_1',
        signal: controller.signal,
      },
      { runAgentTaskFn },
    );

    expect(result.kind).toBe('explain');
    expect(result.text_md).toBe('我们先看这段。');
    expect(result.pendingQuestion).toBeUndefined();
    // PR #305 review comment #3: real task_run_id is returned.
    expect(result.task_run_id).toBe('task_t1');
    // No question persisted (caller owns the transaction).
    const qs = await db.select().from(question);
    expect(qs).toHaveLength(0);
    // TeachingTurnTask ran with allowedTools:[] (no memory, no tool budget — R6).
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'TeachingTurnTask',
      expect.anything(),
      expect.objectContaining({
        allowedTools: [],
        providerSessionDeadlineAt: 456_789,
        taskRunId: 'conversation_attempt_teaching_1',
        signal: controller.signal,
      }),
    );
  });

  it.each(['before_start', 'during_provider'] as const)(
    'does not return a materializable assessment after explicit Stop: %s',
    async (when) => {
      await seedLearningItem('li_cancelled_teaching');
      const sessionId = await seedCopilotSession();
      const controller = new AbortController();
      const stop = new Error('explicit conversation stop');
      const runAgentTaskFn = vi.fn(async () => {
        controller.abort(stop);
        return {
          task_run_id: 'stopped_teaching_attempt',
          text: JSON.stringify({
            kind: 'ask_check',
            text_md: '比较“送孟浩然之广陵”与“人之立志”的“之”，说明两句语法差别。',
            suggested_next: 'continue',
            structured_question: {
              kind: 'short_answer',
              prompt_md: '前者表示前往，后者连接主谓。请结合句子解释，不能只记一个翻译。',
              reference_md: '前句“之”是动词，后句是结构助词；需结合上下文判别。',
            },
          }),
        };
      });
      if (when === 'before_start') controller.abort(stop);
      await expect(
        runTeachingSkill(
          {
            db,
            sessionId,
            learningItemId: 'li_cancelled_teaching',
            userMessage: '用这两个含义不同的句子考我，不要混淆词性。',
            taskRunId: 'stopped_teaching_attempt',
            signal: controller.signal,
          },
          { runAgentTaskFn },
        ),
      ).rejects.toBe(stop);
      expect(runAgentTaskFn).toHaveBeenCalledTimes(when === 'before_start' ? 0 : 1);
      expect(await db.select().from(question)).toHaveLength(0);
    },
  );

  it('ask_check turn: returns pendingQuestion (NOT persisted) with correct params', async () => {
    await seedLearningItem('li_skill_ask');
    const sessionId = await seedCopilotSession();
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_t2',
      text: JSON.stringify({
        kind: 'ask_check',
        text_md: '这里的「之」指代什么？',
        suggested_next: 'continue',
        structured_question: {
          kind: 'short_answer',
          prompt_md: '这里的「之」指代什么？',
          reference_md: '之作代词，指代前文。',
        },
      }),
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));

    const result = await runTeachingSkill(
      {
        db,
        sessionId,
        learningItemId: 'li_skill_ask',
        userMessage: '考我一下',
      },
      { runAgentTaskFn },
    );

    expect(result.kind).toBe('ask_check');
    expect(result.task_run_id).toBe('task_t2');

    // pendingQuestion is populated — NOT yet persisted (PR #305 review #1 atomicity).
    expect(result.pendingQuestion).toMatchObject({
      structured_question: {
        kind: 'short_answer',
        prompt_md: '这里的「之」指代什么？',
      },
      learningItemId: 'li_skill_ask',
      sessionId,
    });

    // The skill itself wrote NO question row — the caller is responsible.
    const qsBefore = await db.select().from(question);
    expect(qsBefore).toHaveLength(0);

    // Single-session: NO second learning_session row was created by the skill.
    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].entrypoint).toBe('copilot');
  });

  it.each([false, true])(
    'commits teaching question and durable reply atomically (fail reply: %s)',
    async (failReply) => {
      const learningItemId = 'li_atomic_teaching_commit';
      await seedLearningItem(learningItemId);
      const sessionId = await seedCopilotSession();
      const now = new Date();
      const askId = await writeCopilotInputEvent(db, {
        sessionId,
        userMessage: '比较代词、动词和结构助词在完整语境中的不同用法。',
        now,
      });
      const structuredQuestion = {
        kind: 'short_answer' as const,
        prompt_md: '“送孟浩然之广陵”和“人之立志”中，“之”各起什么作用？',
        reference_md: '前者是表示前往的动词，后者是结构助词；回答须结合前后词语说明。',
      };
      const commit = writeTeachingCopilotReply(db, {
        sessionId,
        userAskEventId: askId,
        actorRef: 'agent:copilot',
        outcome: 'success',
        durableFinishReason: 'end_turn',
        now,
        skillContext: { skill: 'teaching', ref: { kind: 'learning_item', id: learningItemId } },
        skillResult: {
          task_run_id: 'teaching_atomic_actual_identity',
          kind: 'ask_check',
          text_md: structuredQuestion.prompt_md,
          suggested_next: 'continue',
          pendingQuestion: {
            structured_question: structuredQuestion,
            learningItemId,
            sessionId,
            fallbackPromptMd: structuredQuestion.prompt_md,
          },
        },
        ...(failReply
          ? {
              writeFn: async () => {
                throw new Error('reply commit unavailable');
              },
            }
          : {}),
      });
      if (failReply) {
        await expect(commit).rejects.toThrow('reply commit unavailable');
        expect(await db.select().from(question)).toHaveLength(0);
        expect(
          await db.select().from(event).where(eq(event.caused_by_event_id, askId)),
        ).toHaveLength(0);
        return;
      }
      const written = await commit;
      const [reply] = await db.select().from(event).where(eq(event.id, written.replyEventId));
      const [savedQuestion] = await db.select().from(question);
      expect(savedQuestion.source_ref).toBe(written.replyEventId);
      expect(reply).toMatchObject({
        outcome: 'success',
        caused_by_event_id: askId,
        task_run_id: 'teaching_atomic_actual_identity',
      });
      expect(reply.payload).toMatchObject({
        durable_finish_reason: 'end_turn',
        turn_kind: 'ask_check',
        skill_turn: { kind: 'ask_check', structured_question: { id: savedQuestion.id } },
        skill_context: { skill: 'teaching', ref: { id: learningItemId } },
      });
      expect(reply.payload).not.toHaveProperty('primary_view');
    },
  );

  it('ask_check turn: caller can materialize question stamped with the session id', async () => {
    // This test simulates what runCopilotChat does: take the pendingQuestion and
    // persist it via materializeAskCheckQuestion inside a transaction, then verify
    // the row is stamped with the Copilot session id.
    await seedLearningItem('li_skill_ask_mat');
    const sessionId = await seedCopilotSession();
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_t3',
      text: JSON.stringify({
        kind: 'ask_check',
        text_md: '试题来了。',
        suggested_next: 'continue',
        structured_question: {
          kind: 'short_answer',
          prompt_md: '解释「之」的用法。',
          reference_md: '代词用法，指代前文。',
        },
      }),
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));

    const result = await runTeachingSkill(
      {
        db,
        sessionId,
        learningItemId: 'li_skill_ask_mat',
        userMessage: '考我',
      },
      { runAgentTaskFn },
    );

    expect(result.pendingQuestion).toBeDefined();

    // Simulate the caller's transaction: materialize question + write reply event.
    const fakeReplyEventId = `copilot_reply_${createId()}`;
    const mat = await db.transaction((tx) =>
      materializeAskCheckQuestion(tx, {
        // biome-ignore lint/style/noNonNullAssertion: asserted above
        ...result.pendingQuestion!,
        sourceRef: fakeReplyEventId,
      }),
    );

    expect(mat).toMatchObject({
      kind: 'short_answer',
      prompt_md: '解释「之」的用法。',
    });

    // Now the question row exists, stamped with the Copilot session id.
    const qRows = await db.select().from(question).where(eq(question.id, mat.id));
    expect(qRows).toHaveLength(1);
    expect(qRows[0].source_ref).toBe(fakeReplyEventId);
    // YUK-350 (L2, RL2) — teaching_check lands draft_status='draft' (container-only;
    // never enters the general review pool).
    expect(qRows[0].draft_status).toBe('draft');
    expect(qRows[0].metadata).toMatchObject({
      learning_item_id: 'li_skill_ask_mat',
      session_id: sessionId,
    });
  });
});
