// YUK-14 — POST /api/teaching-sessions/[id]/turn route test.
//
// Covers happy path + idle auto-resume (wasIdle=true in response + session
// transitions idle → active, conversation.resumed job_event written).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, job_events, learning_item, learning_session, question } from '@/db/schema';
import { planTeachingTurn } from '@/server/orchestrator/teaching';
import { Conversation } from '@/server/session';

import { resetDb, testDb } from '../../../../../tests/helpers/db';

// Mock the orchestrator + runner so we don't hit a real LLM
vi.mock('@/server/orchestrator/teaching', async () => {
  const actual = await vi.importActual<typeof import('@/server/orchestrator/teaching')>(
    '@/server/orchestrator/teaching',
  );
  return {
    ...actual,
    planTeachingTurn: vi.fn(async () => ({
      kind: 'explain' as const,
      text_md: '继续讲解。',
      suggested_next: 'continue' as const,
    })),
  };
});

import { POST } from './route';

function turnReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/teaching-sessions/${id}/turn`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function paramsFor(id: string) {
  return Promise.resolve({ id });
}

async function seedLearningItem(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_item).values({
    id,
    source: 'manual',
    title: 'test item',
    content: 'test',
    knowledge_ids: [],
    child_learning_item_ids: [],
    status: 'pending',
    user_pinned: false,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('POST /api/teaching-sessions/[id]/turn', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path: active session, was_idle=false', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_a');
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_turn_a' });

    const res = await POST(turnReq(sessionId, { text_md: '你好' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { was_idle: boolean; agent_message: { text_md: string } };
    expect(body.was_idle).toBe(false);
    expect(body.agent_message.text_md).toBeTruthy();

    // Session still active (no transition for active→active turn)
    const rows = await db
      .select({ status: learning_session.status, version: learning_session.version })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('active');
    expect(rows[0].version).toBe(0); // no transition write
  });

  it('idle resume path: was_idle=true + idle → active + conversation.resumed event', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_b');
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_turn_b' });
    await Conversation.idleConversation(db, sessionId);

    const res = await POST(turnReq(sessionId, { text_md: '我回来了' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { was_idle: boolean };
    expect(body.was_idle).toBe(true);

    const rows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('active');

    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'conversation.resumed')).toBeTruthy();
  });

  it('persists and returns a teaching_check question for ask_check turns', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_check');
    const { sessionId } = await Conversation.startConversation(db, {
      learningItemId: 'li_turn_check',
    });
    vi.mocked(planTeachingTurn).mockResolvedValueOnce({
      kind: 'ask_check',
      text_md: '这里的“之”指代什么？',
      suggested_next: 'continue',
      structured_question: {
        kind: 'short_answer',
        prompt_md: '这里的“之”指代什么？',
        reference_md: '之在这里作代词，指代前文的人或事。',
        judge_kind_override: 'semantic',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖核心要点' }],
          required_points: ['说明之作代词', '说明指代前文'],
        },
      },
    });

    const res = await POST(turnReq(sessionId, { text_md: '考我一下' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_message: {
        id: string;
        turn_kind: string;
        question?: { id: string; kind: string; prompt_md: string; choices_md: string[] | null };
      };
    };
    expect(body.agent_message.turn_kind).toBe('ask_check');
    expect(body.agent_message.question).toMatchObject({
      kind: 'short_answer',
      prompt_md: '这里的“之”指代什么？',
      choices_md: null,
    });

    const qRows = await db
      .select()
      .from(question)
      .where(eq(question.id, body.agent_message.question?.id ?? 'missing'));
    expect(qRows).toHaveLength(1);
    expect(qRows[0]).toMatchObject({
      source: 'teaching_check',
      source_ref: body.agent_message.id,
      reference_md: '之在这里作代词，指代前文的人或事。',
      judge_kind_override: 'semantic',
    });
    expect(qRows[0].metadata).toMatchObject({
      learning_item_id: 'li_turn_check',
      session_id: sessionId,
    });

    const agentEvents = await db
      .select()
      .from(event)
      .where(eq(event.subject_id, body.agent_message.id));
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].payload).toMatchObject({
      role: 'agent',
      turn_kind: 'ask_check',
      question_id: body.agent_message.question?.id,
      question: body.agent_message.question,
    });
  });

  it('returns 409 when session is ended', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_c');
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_turn_c' });
    await Conversation.endConversation(db, sessionId);

    const res = await POST(turnReq(sessionId, { text_md: '...' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(409);
  });

  it('returns 409 when session is abandoned', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_d');
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_turn_d' });
    await Conversation.abandonConversation(db, sessionId, 'orphan_cron');

    const res = await POST(turnReq(sessionId, { text_md: '...' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 when session does not exist', async () => {
    const res = await POST(turnReq('no_such_session', { text_md: 'hi' }), {
      params: paramsFor('no_such_session'),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 on empty text_md', async () => {
    const db = testDb();
    await seedLearningItem('li_turn_e');
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_turn_e' });

    const res = await POST(turnReq(sessionId, { text_md: '' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(400);
  });
});
