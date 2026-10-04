import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learning_session, question } from '@/db/schema';
import { freezeSolveQuestion } from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    text: JSON.stringify({
      reference_solution: {
        expected_signals: ['s'],
        final_answer: 'a + b',
        answer_equivalents: [],
      },
      worked_solution_md: '解：a+b。',
      confidence: 0.9,
    }),
    task_run_id: 'tr',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

const db = testDb();

async function seedBareQuestion(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: null,
    rubric_json: null as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('POST /api/questions/[id]/solve', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('starts a tutor session bound to its issuance without inventing a reference solution', async () => {
    const { POST } = await import('./solve-start');
    const id = await seedBareQuestion();
    const { issuanceId } = await freezeSolveQuestion(db, id, true);
    const res = await POST(
      new Request('http://t/x', {
        method: 'POST',
        body: JSON.stringify({ issuance_id: issuanceId }),
      }),
      { id },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_id: string; issuance_id: string };
    expect(body.session_id).toBeTruthy();
    expect(body.issuance_id).toBe(issuanceId);
    const [s] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(s.type).toBe('tutor');
  });

  it('404s for an unknown question', async () => {
    const { POST } = await import('./solve-start');
    const res = await POST(new Request('http://t/x', { method: 'POST' }), { id: 'nope' });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid regenerate flag instead of silently ignoring it', async () => {
    const { createSolveSession } = await import('./solve-start');
    const res = await createSolveSession(
      new Request('http://t/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ regenerate: 'yes' }),
      }),
      { id: 'question-id' },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'validation_error' });
  });
});
