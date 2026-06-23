import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import type {
  GenerateReferenceSolutionParams,
  GenerateReferenceSolutionResult,
  SolutionGenerateRunTaskFn,
} from '@/server/ai/solution-generate';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { runReferenceAnswerBackfill } from './reference_answer_backfill';

type QFields = Partial<typeof question.$inferInsert> & { id: string; kind: string };
async function seedQuestion(f: QFields) {
  await db.insert(question).values({
    prompt_md: 'P',
    source: 'authentic',
    created_at: new Date(),
    updated_at: new Date(),
    ...f,
    // explicit draft_status (NULL≡active) — keeps test inserts aligned with the
    // audit:draft-status guideline even though test files escape the scan.
    draft_status: f.draft_status ?? null,
  });
}

// A subject root so resolveSubjectProfileForKnowledgeIds(db, ['kc']) resolves a
// real effective domain (the production solver path), used by the cases that
// thread the REAL generateReferenceSolution via the runTaskFn seam.
async function seedKnowledge() {
  await db.insert(knowledge).values({
    id: 'kc-root',
    name: '物理',
    domain: '物理',
    created_at: new Date(),
    updated_at: new Date(),
  });
}

// runTaskFn seam stub: returns the JSON shape SolutionGenerateOutput.parse expects
// (worked_solution_md → reference_md; reference_solution → rubric_json). Exercises
// the REAL generateReferenceSolution write path (merge rubric + set reference_md +
// stamp source) without any model.
const okRunTask: SolutionGenerateRunTaskFn = async () => ({
  text: JSON.stringify({
    worked_solution_md: 'WORKED-SOLUTION',
    reference_solution: {
      expected_signals: ['signal-a'],
      final_answer: '42',
      answer_equivalents: [],
    },
    confidence: 0.9,
  }),
});

describe('reference_answer_backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fills a reference_md IS NULL question (≥1 knowledge_id) → reference_md set, filled counted', async () => {
    await seedKnowledge();
    await seedQuestion({ id: 'q-fill', kind: 'short_answer', knowledge_ids: ['kc-root'] });

    const res = await runReferenceAnswerBackfill(db, { runTaskFn: okRunTask });

    expect(res).toEqual({ scanned: 1, filled: 1, skipped: 0 });
    const [row] = await db.select().from(question).where(eq(question.id, 'q-fill'));
    expect(row.reference_md).toBe('WORKED-SOLUTION');
    // generateReferenceSolution stamps the provenance marker alongside the rubric.
    expect((row.rubric_json as Record<string, unknown>).reference_solution_source).toBe(
      'ai_generated',
    );
  });

  it('write-guard: a question that ALREADY has reference_md is not in scan / not overwritten', async () => {
    await seedKnowledge();
    await seedQuestion({
      id: 'q-has-ref',
      kind: 'short_answer',
      knowledge_ids: ['kc-root'],
      reference_md: 'ORIGINAL',
    });
    // A generateFn that throws would surface if the row were (wrongly) attempted.
    const generateFn = vi.fn(async (): Promise<GenerateReferenceSolutionResult> => {
      throw new Error('must not be called for a non-null reference_md row');
    });

    const res = await runReferenceAnswerBackfill(db, { generateFn });

    expect(generateFn).not.toHaveBeenCalled();
    expect(res).toEqual({ scanned: 0, filled: 0, skipped: 0 });
    const [row] = await db.select().from(question).where(eq(question.id, 'q-has-ref'));
    expect(row.reference_md).toBe('ORIGINAL');
  });

  it('idempotent: a 2nd run after the first finds nothing → filled:0 no-op', async () => {
    await seedKnowledge();
    await seedQuestion({ id: 'q-idem', kind: 'short_answer', knowledge_ids: ['kc-root'] });

    const first = await runReferenceAnswerBackfill(db, { runTaskFn: okRunTask });
    expect(first.filled).toBe(1);

    const generateFn = vi.fn(async (): Promise<GenerateReferenceSolutionResult> => {
      throw new Error('second run must not attempt any row');
    });
    const second = await runReferenceAnswerBackfill(db, { generateFn });
    expect(generateFn).not.toHaveBeenCalled();
    expect(second).toEqual({ scanned: 0, filled: 0, skipped: 0 });
  });

  it('error-skip: a stubbed generate failure leaves the row NULL + skipped counted + batch continues', async () => {
    await seedKnowledge();
    await seedQuestion({ id: 'q-err', kind: 'short_answer', knowledge_ids: ['kc-root'] });
    await seedQuestion({ id: 'q-ok', kind: 'short_answer', knowledge_ids: ['kc-root'] });

    // Stub the full solver outcome: the first row skipped_error (no throw — the
    // solver swallows LLM/parse errors), the second generated. The batch must
    // continue past the failure and fill the second row.
    const generateFn = vi.fn(
      async (params: GenerateReferenceSolutionParams): Promise<GenerateReferenceSolutionResult> => {
        if (params.questionId === 'q-err') {
          return { status: 'skipped_error', reason: 'stubbed LLM failure' };
        }
        await db
          .update(question)
          .set({ reference_md: 'FILLED-OK' })
          .where(eq(question.id, params.questionId));
        return { status: 'generated', final_answer: 'ok' };
      },
    );

    const res = await runReferenceAnswerBackfill(db, { generateFn });

    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ scanned: 2, filled: 1, skipped: 1 });
    // The failed row is left NULL (next run retries).
    const [errRow] = await db.select().from(question).where(eq(question.id, 'q-err'));
    expect(errRow.reference_md).toBeNull();
    // The healthy row in the same batch is filled.
    const [okRow] = await db.select().from(question).where(eq(question.id, 'q-ok'));
    expect(okRow.reference_md).toBe('FILLED-OK');
  });

  it('subject-unresolvable: a reference_md IS NULL question with NO knowledge_id is skipped, not attempted', async () => {
    // knowledge_ids defaults to [] (notNull default) — no resolvable subject.
    await seedQuestion({ id: 'q-no-kc', kind: 'short_answer' });
    const generateFn = vi.fn(async (): Promise<GenerateReferenceSolutionResult> => {
      throw new Error('must not attempt a no-knowledge_id row');
    });

    const res = await runReferenceAnswerBackfill(db, { generateFn });

    // The row is scanned (reference_md IS NULL) but skipped before the solver call.
    expect(generateFn).not.toHaveBeenCalled();
    expect(res).toEqual({ scanned: 1, filled: 0, skipped: 1 });
    const [row] = await db.select().from(question).where(eq(question.id, 'q-no-kc'));
    expect(row.reference_md).toBeNull();
  });
});
