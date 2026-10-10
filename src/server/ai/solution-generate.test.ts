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
});
