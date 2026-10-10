// AF S4 / YUK-203 U6 (OQ2/OQ7/OQ9, R2 — single-session) — teaching-skill DB tests.
//
// A teaching turn inside Copilot lives ENTIRELY on the Copilot session:
//   - ask_check turns return a pendingQuestion (NOT yet persisted — the caller,
//     runCopilotChat, wraps the question INSERT + reply event in one transaction
//     for atomicity; PR #305 review comment #1).
//   - the materialized question is stamped with the Copilot session id as provenance.
//   - NO second learning_session row is created by the skill.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, learning_item, question } from '@/db/schema';
import { Conversation } from '@/server/session';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { writeCopilotInputEvent, writeTeachingCopilotReply } from '../conversation-writes';

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
});
