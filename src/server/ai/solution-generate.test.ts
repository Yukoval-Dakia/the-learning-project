import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { question } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { generateReferenceSolution } from './solution-generate';

const db = testDb();

function validLlmText() {
  return JSON.stringify({
    reference_solution: {
      expected_signals: ['用平方差因式分解', '约去 a−b'],
      final_answer: 'a + b',
      answer_equivalents: ['a+b'],
    },
    worked_solution_md: '先因式分解，再约分，得 a+b。',
    confidence: 0.9,
  });
}

async function seedQuestion(opts: {
  rubric_json?: unknown;
  reference_md?: string | null;
  kind?: string;
  choices_md?: string[] | null;
}): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'derivation',
    prompt_md: '化简 (a^2 - b^2)/(a - b)',
    reference_md: opts.reference_md ?? null,
    choices_md: opts.choices_md ?? null,
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

describe('generateReferenceSolution', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('generates + writes reference_solution + reference_md + provenance on a bare question', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: validLlmText(),
    }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('generated');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    const rubric = row.rubric_json as {
      reference_solution: { expected_signals: string[]; final_answer: string };
      reference_solution_source?: string;
    };
    expect(rubric.reference_solution.expected_signals.length).toBeGreaterThanOrEqual(1);
    expect(rubric.reference_solution.final_answer).toBe('a + b');
    expect(rubric.reference_solution_source).toBe('ai_generated');
    expect(row.reference_md).toContain('因式分解');
  });

  it('passes choices_md to SolutionGenerateTask when the row is choice-style', async () => {
    const id = await seedQuestion({
      kind: 'choice',
      choices_md: ['A. a + b', 'B. a - b'],
    });
    let capturedInput: unknown;
    const runTaskFn = vi.fn(async (_kind: string, input: unknown, _ctx: unknown) => {
      capturedInput = input;
      return { text: validLlmText() };
    });

    await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(capturedInput).toMatchObject({ choices_md: ['A. a + b', 'B. a - b'] });
  });

  it('is idempotent — skips when reference_solution already present', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['authored signal'],
          final_answer: 'AUTHORED',
          answer_equivalents: [],
        },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_exists');
    expect(runTaskFn).not.toHaveBeenCalled();
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(
      (row.rubric_json as { reference_solution: { final_answer: string } }).reference_solution
        .final_answer,
    ).toBe('AUTHORED');
  });

  it('write-guard: skips (does NOT clobber) a reference_md set concurrently — reference_md non-null + no rubric solution + !regenerate', async () => {
    // TOCTOU window: a row whose reference_md was set by another path (e.g. OCR enroll) but whose
    // rubric has no reference_solution. The early rubric idempotency check does NOT catch this (it
    // keys on rubric_json.reference_solution), so we reach the UPDATE — which must be guarded on
    // reference_md IS NULL and therefore SKIP rather than overwrite the real answer with an AI guess.
    const id = await seedQuestion({
      reference_md: 'REAL OCR ANSWER',
      rubric_json: { criteria: [] },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_exists');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.reference_md).toBe('REAL OCR ANSWER'); // NOT clobbered by the AI worked solution
  });

  it('regenerate=true overwrites an existing reference_solution', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['authored signal'],
          final_answer: 'AUTHORED',
          answer_equivalents: [],
        },
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    const result = await generateReferenceSolution({
      db,
      questionId: id,
      runTaskFn,
      regenerate: true,
    });

    expect(result.status).toBe('generated');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(
      (row.rubric_json as { reference_solution: { final_answer: string } }).reference_solution
        .final_answer,
    ).toBe('a + b');
  });

  it('preserves existing criteria / keywords when merging the generated reference_solution', async () => {
    const id = await seedQuestion({
      rubric_json: {
        criteria: [{ name: 'method', weight: 1, descriptor: 'kept' }],
        keywords: ['kw1'],
        required_points: ['rp1'],
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));

    await generateReferenceSolution({ db, questionId: id, runTaskFn });

    const [row] = await db.select().from(question).where(eq(question.id, id));
    const rubric = row.rubric_json as {
      criteria: { name: string }[];
      keywords: string[];
      required_points: string[];
      reference_solution: { final_answer: string };
    };
    expect(rubric.criteria).toEqual([{ name: 'method', weight: 1, descriptor: 'kept' }]);
    expect(rubric.keywords).toEqual(['kw1']);
    expect(rubric.required_points).toEqual(['rp1']);
    expect(rubric.reference_solution.final_answer).toBe('a + b');
  });

  it('logged-skip on LLM throw — question untouched, no exception', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => {
      throw new Error('XIAOMI_API_KEY missing');
    });

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_error');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.rubric_json).toBeNull();
    expect(row.reference_md).toBeNull();
  });

  it('logged-skip on unparseable LLM output — question untouched', async () => {
    const id = await seedQuestion({});
    const runTaskFn = vi.fn(async () => ({ text: 'not json at all' }));

    const result = await generateReferenceSolution({ db, questionId: id, runTaskFn });

    expect(result.status).toBe('skipped_error');
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.rubric_json).toBeNull();
  });

  it('returns skipped_not_found for an unknown question id', async () => {
    const runTaskFn = vi.fn(async () => ({ text: validLlmText() }));
    const result = await generateReferenceSolution({ db, questionId: 'nope', runTaskFn });
    expect(result.status).toBe('skipped_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});
