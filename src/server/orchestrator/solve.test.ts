import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { learning_session, question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { startSolveSession } from './solve';

const db = testDb();

async function seedQuestion(opts: { rubric_json?: unknown }): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: null,
    rubric_json: (opts.rubric_json ?? null) as never,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

const VALID_GEN = JSON.stringify({
  reference_solution: {
    expected_signals: ['s1'],
    final_answer: 'a + b',
    answer_equivalents: ['a+b'],
  },
  worked_solution_md: '解：a+b。',
  confidence: 0.9,
});

describe('startSolveSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lazily generates a reference solution then creates a tutor session', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => ({ text: VALID_GEN }));

    const { sessionId, generated } = await startSolveSession({ db, questionId: id, runTaskFn });

    expect(generated).toBe(true);
    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.type).toBe('tutor');
    expect(s.status).toBe('active');
    expect(s.goal_id).toBe(id);
    const [q] = await db.select().from(question).where(eq(question.id, id));
    expect(
      (q.rubric_json as { reference_solution: { final_answer: string } }).reference_solution
        .final_answer,
    ).toBe('a + b');
  });

  it('skips generation when reference_solution already present', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: { expected_signals: ['s'], final_answer: 'A', answer_equivalents: [] },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: VALID_GEN }));

    const { generated } = await startSolveSession({ db, questionId: id, runTaskFn });

    expect(generated).toBe(false);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('still creates a session (degraded) when generation fails', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM down');
    });

    const { sessionId, generated, generationError } = await startSolveSession({
      db,
      questionId: id,
      runTaskFn,
    });

    expect(generated).toBe(false);
    expect(generationError).toBe(true);
    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('active'); // session opens; judge will degrade later
  });

  it('throws SolveError(question_not_found) for an unknown question', async () => {
    const runTaskFn = vi.fn();
    await expect(startSolveSession({ db, questionId: 'nope', runTaskFn })).rejects.toMatchObject({
      code: 'question_not_found',
    });
  });
});
