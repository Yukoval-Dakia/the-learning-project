import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_record, learning_session, question } from '@/db/schema';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../../../../tests/helpers/db';

vi.mock('@/server/judge/invoker', () => ({
  createDefaultJudgeInvoker: () => ({
    invoke: vi.fn(async (input: { question: { id: string } }) => ({
      route: 'steps',
      result: {
        score: 0,
        score_meaning: 'steps_v1_weighted',
        coarse_outcome: 'incorrect',
        confidence: 0.9,
        capability_ref: { id: 'steps', version: '1.0.0' },
        feedback_md: 'fb',
        evidence_json: {},
      },
      telemetry: {
        route: 'steps',
        capability_ref: { id: 'steps', version: '1.0.0' },
        coarse_outcome: 'incorrect',
        confidence: 0.9,
        elapsed_ms: 1,
        question_id: input.question.id,
        subject_id: 'math',
      },
    })),
  }),
}));

const db = testDb();

async function seedAndStart(): Promise<{ id: string; sessionId: string }> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: '完整解：a+b。',
    rubric_json: {
      criteria: [],
      reference_solution: {
        expected_signals: ['s'],
        final_answer: 'a + b',
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
  const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
  return { id, sessionId };
}

describe('POST /api/questions/[id]/solve/[sid]/submit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('typed submit → judged, reveals solution, enrolls mistake on low score', async () => {
    const { POST } = await import('./route');
    const { id, sessionId } = await seedAndStart();

    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({ student_final_answer_text: 'wrong' }),
      }),
      { params: Promise.resolve({ id, sid: sessionId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      judge: { coarse_outcome: string };
      revealed_solution_md: string;
      mistake_id?: string;
    };
    expect(body.judge.coarse_outcome).toBe('incorrect');
    expect(body.revealed_solution_md).toContain('a+b');
    expect(body.mistake_id).toBeDefined();

    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('judged');
    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, id));
    expect(records).toHaveLength(1);
  });

  it('400 on an all-empty submission', async () => {
    const { POST } = await import('./route');
    const { id, sessionId } = await seedAndStart();
    const res = await POST(
      new Request('http://t/x', { method: 'POST', body: JSON.stringify({}) }),
      { params: Promise.resolve({ id, sid: sessionId }) },
    );
    expect(res.status).toBe(400);
  });
});
