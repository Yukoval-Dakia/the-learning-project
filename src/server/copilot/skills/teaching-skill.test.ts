// AF S4 / YUK-203 U6 (OQ2/OQ7/OQ9, R2 — single-session) — teaching-skill DB tests.
//
// A teaching turn inside Copilot lives ENTIRELY on the Copilot session:
//   - the ask_check question is materialized with metadata.session_id = the
//     Copilot session id (NOT a second teaching session),
//   - getActiveQuestionState resolves it against the Copilot session id,
//   - NO second learning_session row is created by the skill.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_item, learning_session, question } from '@/db/schema';
import { Conversation } from '@/server/session';
import { getActiveQuestionState } from '@/server/teaching/active-question';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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

  it('explain turn: returns text + kind, materializes no question', async () => {
    await seedLearningItem('li_skill_explain');
    const sessionId = await seedCopilotSession();
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
        replyEventId: 'copilot_reply_x',
      },
      { runAgentTaskFn },
    );

    expect(result.kind).toBe('explain');
    expect(result.text_md).toBe('我们先看这段。');
    expect(result.structured_question).toBeUndefined();
    // No question materialized.
    const qs = await db.select().from(question);
    expect(qs).toHaveLength(0);
    // TeachingTurnTask ran with allowedTools:[] (no memory, no tool budget — R6).
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'TeachingTurnTask',
      expect.anything(),
      expect.objectContaining({ allowedTools: [] }),
    );
  });

  it('ask_check turn: materializes a question stamped with the COPILOT session id', async () => {
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
        replyEventId: 'copilot_reply_ask',
      },
      { runAgentTaskFn },
    );

    expect(result.kind).toBe('ask_check');
    expect(result.structured_question).toMatchObject({
      kind: 'short_answer',
      prompt_md: '这里的「之」指代什么？',
      choices_md: null,
    });

    // The question is stamped with the COPILOT session id (single-session, OQ7/OQ9).
    const qRows = await db
      .select()
      .from(question)
      .where(eq(question.id, result.structured_question?.id ?? 'missing'));
    expect(qRows).toHaveLength(1);
    expect(qRows[0].source).toBe('teaching_check');
    expect(qRows[0].source_ref).toBe('copilot_reply_ask');
    expect(qRows[0].metadata).toMatchObject({
      learning_item_id: 'li_skill_ask',
      session_id: sessionId,
    });

    // getActiveQuestionState resolves it against the COPILOT session id (the reader
    // keys purely on metadata.session_id — no learning_session.type filter).
    const active = await getActiveQuestionState(db, sessionId);
    expect(active.active_question_id).toBe(result.structured_question?.id);

    // Single-session: NO second learning_session row was created by the skill
    // (only the one Copilot conversation session exists).
    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].entrypoint).toBe('copilot');
  });
});
