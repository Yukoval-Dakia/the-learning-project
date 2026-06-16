// AF S4 / YUK-203 U6 (OQ2/OQ7/OQ9, R2 — single-session) — teaching-skill DB tests.
//
// A teaching turn inside Copilot lives ENTIRELY on the Copilot session:
//   - ask_check turns return a pendingQuestion (NOT yet persisted — the caller,
//     runCopilotChat, wraps the question INSERT + reply event in one transaction
//     for atomicity; PR #305 review comment #1).
//   - getActiveQuestionState resolves against the Copilot session id once the
//     caller completes the materialization.
//   - NO second learning_session row is created by the skill.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveQuestionState } from '@/capabilities/copilot/server/teaching/active-question';
import { materializeAskCheckQuestion } from '@/capabilities/copilot/server/teaching/materialize-ask-check';
import { learning_item, learning_session, question } from '@/db/schema';
import { Conversation } from '@/server/session';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
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
      expect.objectContaining({ allowedTools: [] }),
    );
  });

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

  it('ask_check turn: caller can materialize question + verify active-question state', async () => {
    // This test simulates what runCopilotChat does: take the pendingQuestion and
    // persist it via materializeAskCheckQuestion inside a transaction, then verify
    // getActiveQuestionState resolves it against the Copilot session.
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

    // getActiveQuestionState resolves it against the COPILOT session id (the reader
    // keys purely on metadata.session_id — no learning_session.type filter). This is
    // the container-read face: a draft teaching_check is still resolved here (no draft
    // filter on the container path).
    const active = await getActiveQuestionState(db, sessionId);
    expect(active.active_question_id).toBe(mat.id);
  });
});
