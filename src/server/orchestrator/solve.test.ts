import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, learning_record, learning_session, question } from '@/db/schema';
import type { JudgeInvokerOutput } from '@/server/judge/invoker';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { planSolveHint, startSolveSession, submitSolveAttempt } from './solve';

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

describe('planSolveHint', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a non-revealing hint via TeachingTurnTask', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['s'],
          final_answer: 'a + b',
          answer_equivalents: [],
        },
      },
    });
    await db
      .update(question)
      .set({ reference_md: '完整解：先因式分解，再约分得 a+b。' })
      .where(eq(question.id, id));
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const turnText = JSON.stringify({
      kind: 'explain',
      text_md: '想想分子能不能因式分解？',
      suggested_next: 'continue',
    });
    const runTaskFn = vi.fn(async () => ({ text: turnText }));

    const hint = await planSolveHint({ db, sessionId, hintIndex: 0, runTaskFn });

    expect(hint.text_md).toContain('因式分解');
    expect(hint.text_md).not.toContain('a+b'); // does not reveal the final answer
    expect(runTaskFn).toHaveBeenCalledWith(
      'TeachingTurnTask',
      expect.anything(),
      expect.anything(),
    );
  });

  it('throws for an unknown session', async () => {
    const runTaskFn = vi.fn();
    await expect(
      planSolveHint({ db, sessionId: 'nope', hintIndex: 0, runTaskFn }),
    ).rejects.toThrow();
  });
});

function seededRubricQuestion() {
  return {
    rubric_json: {
      criteria: [],
      reference_solution: {
        expected_signals: ['s1', 's2'],
        final_answer: 'a + b',
        answer_equivalents: ['a+b'],
      },
    },
  };
}

function judgeStub(outcome: 'correct' | 'incorrect' | 'partial', score: number) {
  // Cast to JudgeInvokerOutput: the real result is a discriminated union on
  // coarse_outcome with score bounds per arm (correct ≥0.85, incorrect ===0),
  // which a parameterised stub can't satisfy structurally. The orchestrator
  // only reads route/result.{coarse_outcome,score,confidence,feedback_md,
  // evidence_json}, so the cast is runtime-faithful.
  return vi.fn(
    async () =>
      ({
        route: 'steps' as const,
        result: {
          score,
          score_meaning: 'steps_v1_weighted',
          coarse_outcome: outcome,
          confidence: 0.9,
          capability_ref: { id: 'steps', version: '1.0.0' },
          feedback_md: 'fb',
          evidence_json: {},
        },
        telemetry: {
          route: 'steps' as const,
          capability_ref: { id: 'steps', version: '1.0.0' },
          coarse_outcome: outcome,
          confidence: 0.9,
          elapsed_ms: 1,
          question_id: 'q',
          subject_id: 'math',
        },
      }) as unknown as JudgeInvokerOutput,
  );
}

describe('submitSolveAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('typed submit → judge → attempt event written → session judged → reveals worked solution', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    await db.update(question).set({ reference_md: '完整解：a+b。' }).where(eq(question.id, id));
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const judgeFn = judgeStub('correct', 0.95);
    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_text_steps: ['因式分解', '约分'], student_final_answer_text: 'a+b' },
      judgeFn,
    });

    expect(res.judge.coarse_outcome).toBe('correct');
    expect(res.revealed_solution_md).toContain('a+b');
    expect(res.mistake_id).toBeUndefined();

    const [s] = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(s.status).toBe('judged');

    const attempts = await db.select().from(event).where(eq(event.subject_id, id));
    expect(attempts.some((e) => e.action === 'attempt')).toBe(true);
  });

  it('handwritten-photo submit (student_image_refs) follows the same path', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('correct', 0.9);

    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_image_refs: ['asset_1'] },
      judgeFn,
    });

    expect(res.judge.coarse_outcome).toBe('correct');
    expect(judgeFn).toHaveBeenCalledWith(
      expect.objectContaining({ student_image_refs: ['asset_1'] }),
    );
  });

  it('low score (incorrect) enrolls a mistake learning_record', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('incorrect', 0);

    const res = await submitSolveAttempt({
      db,
      sessionId,
      submission: { student_final_answer_text: 'wrong' },
      judgeFn,
    });

    expect(res.mistake_id).toBeDefined();
    const records = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.question_id, id));
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('mistake');
  });

  it('rejects an all-empty submission', async () => {
    const id = await seedQuestion(seededRubricQuestion());
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });
    const judgeFn = judgeStub('correct', 1);

    await expect(
      submitSolveAttempt({ db, sessionId, submission: {}, judgeFn }),
    ).rejects.toMatchObject({ code: 'empty_submission' });
    expect(judgeFn).not.toHaveBeenCalled();
  });
});
