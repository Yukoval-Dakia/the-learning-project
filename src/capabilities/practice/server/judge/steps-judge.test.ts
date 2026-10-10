import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { JudgeQuestionRow } from './question-contract';
import { runStepsJudge } from './steps-judge';

// runStepsJudge is pure-logic once runTaskFn + imageFetchFn are stubbed.
// A throwaway cast suffices — the function only passes db through to the stubs.
const mockDb = {} as Db;
const mathProfile = resolveSubjectProfile('math');

function makeDerivationRow(opts: {
  expected_signals?: string[];
  answer_equivalents?: string[];
  image_refs?: string[];
}): JudgeQuestionRow {
  return {
    id: 'q-d',
    kind: 'derivation',
    prompt_md: '化简 $\\frac{a^2 - b^2}{a - b}$',
    reference_md: '$a + b$',
    rubric_json: {
      criteria: [{ name: 'method', weight: 1, descriptor: 'ok' }],
      reference_solution: {
        expected_signals: opts.expected_signals ?? ['用平方差因式分解', '约去 a−b', '得 a+b'],
        final_answer: 'a + b',
        answer_equivalents: opts.answer_equivalents ?? ['a+b', '(a) + (b)'],
      },
    },
    choices_md: null,
    judge_kind_override: null,
    image_refs: opts.image_refs ?? [],
  };
}

describe('runStepsJudge — accelerator path', () => {
  it('hits accelerator when student final_answer matches answer_equivalents', async () => {
    const runTaskFn = vi.fn();
    const imageFetchFn = vi.fn();
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'a+b',
      subjectProfile: mathProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(imageFetchFn).not.toHaveBeenCalled();
    expect(result.coarse_outcome).toBe('partial');
    expect((result.evidence_json as { accelerator?: string }).accelerator).toBe(
      'final_answer_match',
    );
    expect(result.score).toBeCloseTo(0.4, 2);
  });

  it('hits accelerator when student types canonical final_answer', async () => {
    const runTaskFn = vi.fn();
    const imageFetchFn = vi.fn();
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'a + b', // canonical from reference_solution.final_answer
      subjectProfile: mathProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(result.coarse_outcome).toBe('partial');
    expect((result.evidence_json as { accelerator?: string }).accelerator).toBe(
      'final_answer_match',
    );
  });
});

describe('runStepsJudge — score composition (step_weight=0.6)', () => {
  function llmResponseFromVerdicts(
    verdicts: Array<'correct' | 'partial' | 'wrong' | 'skipped'>,
    finalMatch: boolean,
  ) {
    return {
      text: JSON.stringify({
        extracted_steps: [],
        extracted_final_answer: 'x',
        signal_verdicts: verdicts.map((v, i) => ({ signal_idx: i, verdict: v, comment: '' })),
        final_answer_match: finalMatch,
        final_answer_comment: '',
        confidence: 0.9,
      }),
    };
  }

  it('all 3 signals correct + final match → score 1.0 → correct', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'this triggers LLM (not in equivalents)',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['correct', 'correct', 'correct'], true),
      imageFetchFn: async () => [],
    });
    expect(result.score).toBeCloseTo(1.0, 2);
    expect(result.coarse_outcome).toBe('correct');
  });

  it('2/3 correct steps + final wrong → score ≈ 0.4 → partial', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['correct', 'correct', 'wrong'], false),
      imageFetchFn: async () => [],
    });
    expect(result.score).toBeCloseTo(0.4, 2);
    expect(result.coarse_outcome).toBe('partial');
  });

  it('all wrong + final wrong → score 0 → incorrect', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['wrong', 'wrong', 'wrong'], false),
      imageFetchFn: async () => [],
    });
    expect(result.score).toBe(0);
    expect(result.coarse_outcome).toBe('incorrect');
  });

  it('all partial + final match → score 0.7 → partial', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => llmResponseFromVerdicts(['partial', 'partial', 'partial'], true),
      imageFetchFn: async () => [],
    });
    expect(result.score).toBeCloseTo(0.7, 2);
    expect(result.coarse_outcome).toBe('partial');
  });
});
