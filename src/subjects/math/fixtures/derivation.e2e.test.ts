import { question } from '@/db/schema';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
/**
 * M2.2 — e2e smoke for derivation question end-to-end.
 *
 * Inserts derivation fixtures directly via testDb (bypasses HTTP seed
 * endpoint — integration test, not HTTP test). Then exercises two paths
 * through the steps@1 judge:
 *
 *  1. Accelerator path: student answer is in answer_equivalents → LLM
 *     skipped, coarse_outcome=partial (only final_answer credit, no step
 *     credit because steps were not submitted).
 *  2. LLM path: answer not in equivalents → mocked runTaskFn returns a
 *     StepsLlmOutput with 2/3 correct signals → partial credit composed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadMathDerivationFixtures } from './derivation';

describe('math derivation e2e (M2.2)', () => {
  const mathProfile = resolveSubjectProfile('math');
  let db: ReturnType<typeof testDb>;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDb();
    const fixtures = loadMathDerivationFixtures();
    const now = new Date();
    for (const item of fixtures) {
      await db.insert(question).values({
        id: `q-deriv-${item.ref}`,
        kind: item.kind,
        prompt_md: item.prompt_md,
        reference_md: item.reference_md,
        choices_md: null,
        rubric_json: item.rubric_json,
        knowledge_ids: [],
        difficulty: item.difficulty,
        source: 'math_fixture_test',
        variant_depth: 0,
        figures: [],
        image_refs: [],
        structured: null,
        metadata: { fixture_ref: item.ref },
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
  });

  it('accelerator path: student types final answer that hits answer_equivalents', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-deriv-math-derivation-003'));
    expect(row).toBeDefined();

    const judgeRow: JudgeQuestionRow = {
      id: row.id,
      kind: row.kind,
      prompt_md: row.prompt_md,
      reference_md: row.reference_md,
      rubric_json: row.rubric_json,
      choices_md: row.choices_md,
      judge_kind_override: row.judge_kind_override,
      figures: row.figures,
      image_refs: row.image_refs,
      structured: row.structured,
    };

    // fixture 003 (一元一次方程) has answer_equivalents = ['x=4', '4', 'x = 4']
    const result = await judgeAnswer({
      db,
      question: judgeRow,
      answer_md: 'x=4',
      subjectProfile: mathProfile,
      runTaskFn: async () => {
        throw new Error('accelerator path should not call LLM');
      },
    });

    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('partial');
    expect((result.result.evidence_json as { accelerator?: string }).accelerator).toBe(
      'final_answer_match',
    );
  });

  it('LLM path: student answer not in equivalents — calls mock LLM, partial credit composed', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-deriv-math-derivation-002'));
    expect(row).toBeDefined();

    const judgeRow: JudgeQuestionRow = {
      id: row.id,
      kind: row.kind,
      prompt_md: row.prompt_md,
      reference_md: row.reference_md,
      rubric_json: row.rubric_json,
      choices_md: row.choices_md,
      judge_kind_override: row.judge_kind_override,
      figures: row.figures,
      image_refs: row.image_refs,
      structured: row.structured,
    };

    const result = await judgeAnswer({
      db,
      question: judgeRow,
      answer_md: '我尝试做但不确定',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({
          extracted_steps: [{ idx: 0, content: '2x→x^2', verdict: 'correct', comment: '' }],
          extracted_final_answer: 'x^2 + 3x',
          // fixture 002 (积分) has 3 expected_signals — must return 3 verdicts
          signal_verdicts: [
            { signal_idx: 0, verdict: 'correct', comment: '' },
            { signal_idx: 1, verdict: 'correct', comment: '' },
            { signal_idx: 2, verdict: 'wrong', comment: '缺常数 C' },
          ],
          final_answer_match: false,
          final_answer_comment: 'missing +C',
          confidence: 0.8,
        }),
      }),
    });

    expect(result.route).toBe('steps');
    // step_score_raw = (1 + 1 + 0) / 3 ≈ 0.667
    // score = 0.6 * 0.667 + 0.4 * 0 ≈ 0.4 → partial
    expect(result.result.coarse_outcome).toBe('partial');
    expect(result.result.score).toBeCloseTo(0.4, 1);
    expect(
      (result.result.evidence_json as { signal_verdicts?: unknown }).signal_verdicts,
    ).toBeDefined();
  });
});
