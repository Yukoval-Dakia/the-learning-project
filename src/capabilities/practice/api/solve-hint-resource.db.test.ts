import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, question } from '@/db/schema';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    text: JSON.stringify({
      kind: 'explain',
      text_md: '先尝试把分子因式分解。',
      suggested_next: 'continue',
    }),
    task_run_id: 'hint_task',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

const db = testDb();

async function seedQuestion(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简表达式',
    reference_md: '完整解答',
    rubric_json: {
      criteria: [],
      reference_solution: {
        expected_signals: ['factor'],
        final_answer: 'a+b',
        answer_equivalents: [],
      },
    } as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('hint-request resource', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a durable hint request id and appends an audit event', async () => {
    const questionId = await seedQuestion();
    const { sessionId } = await Tutor.startTutorSession(db, { questionId });
    const { createHintRequest } = await import('./solve-hint');

    const response = await createHintRequest(
      new Request('http://localhost/api/hints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hint_index: 1 }),
      }),
      { id: questionId, sid: sessionId },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { hint_request_id: string; text_md: string };
    expect(body.hint_request_id).toBeTruthy();
    expect(body.text_md).toContain('因式分解');

    const rows = await db
      .select()
      .from(event)
      .where(
        and(eq(event.id, body.hint_request_id), eq(event.action, 'experimental:hint_request')),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: sessionId,
      subject_kind: 'question',
      subject_id: questionId,
      payload: { hint_index: 1 },
    });
  });
});
