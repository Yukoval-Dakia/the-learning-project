import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it, vi } from 'vitest';
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

  it('does NOT hit accelerator when answer differs (LLM called)', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        extracted_steps: [],
        extracted_final_answer: 'wrong',
        signal_verdicts: [
          { signal_idx: 0, verdict: 'wrong', comment: '' },
          { signal_idx: 1, verdict: 'wrong', comment: '' },
          { signal_idx: 2, verdict: 'wrong', comment: '' },
        ],
        final_answer_match: false,
        final_answer_comment: 'no',
        confidence: 0.9,
      }),
    }));
    const imageFetchFn = vi.fn(async () => []);
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'not the answer',
      subjectProfile: mathProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(runTaskFn).toHaveBeenCalledOnce();
    expect(result.coarse_outcome).toBe('incorrect');
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

describe('runStepsJudge — error paths', () => {
  it('returns unsupported when reference_solution missing from rubric', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: {
        ...makeDerivationRow({}),
        rubric_json: { criteria: [{ name: 'x', weight: 1, descriptor: 'y' }] }, // no reference_solution
      },
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({ text: '{}' }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('reference_solution missing');
  });

  it('returns unsupported when LLM output is non-JSON', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({ text: 'no json here' }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    // extractJsonObject throws "did not contain a JSON object"; this is surfaced
    // in evidence_json.error. The feedback_md uses the outer unsupportedResult reason.
    expect(result.feedback_md).toContain('did not match StepsLlmOutput schema');
    expect((result.evidence_json as { error?: string }).error).toContain(
      'did not contain a JSON object',
    );
  });

  it('returns unsupported when signal_verdicts length mismatches expected_signals', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({ expected_signals: ['s1', 's2', 's3'] }),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({
          extracted_steps: [],
          extracted_final_answer: '',
          signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: '' }],
          final_answer_match: false,
          final_answer_comment: '',
          confidence: 0.5,
        }),
      }),
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('signal_verdicts length mismatch');
  });

  it('returns unsupported when LLM call throws', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}),
      answer_md: 'foo',
      subjectProfile: mathProfile,
      runTaskFn: async () => {
        throw new Error('LLM down');
      },
      imageFetchFn: async () => [],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('LLM call failed');
  });

  it('returns unsupported when imageFetchFn throws', async () => {
    const result = await runStepsJudge({
      db: mockDb,
      question: makeDerivationRow({}), // no question.image_refs needed
      answer_md: 'foo',
      student_image_refs: ['asset-1'], // ← move to student channel
      subjectProfile: mathProfile,
      runTaskFn: async () => ({ text: '{}' }),
      imageFetchFn: async () => {
        throw new Error('R2 unavailable');
      },
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('image fetch failed');
  });

  it('passes student_image_refs (NOT question.image_refs) to imageFetchFn', async () => {
    // M2.2 fix: question.image_refs are prompt figures; student_image_refs
    // are answer photos. The judge must consume student channel.
    const calls: string[][] = [];
    const imageFetchFn = vi.fn(async (assetIds: string[]) => {
      calls.push(assetIds);
      return assetIds.map((_id) => ({ data: 'AAA', mediaType: 'image/png' }));
    });
    await runStepsJudge({
      db: mockDb,
      question: { ...makeDerivationRow({ image_refs: ['prompt-figure-1'] }) },
      answer_md: 'student writes something that does not hit equivalents',
      student_image_refs: ['student-photo-1', 'student-photo-2'],
      subjectProfile: mathProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({
          extracted_steps: [],
          extracted_final_answer: '',
          signal_verdicts: [
            { signal_idx: 0, verdict: 'partial', comment: '' },
            { signal_idx: 1, verdict: 'partial', comment: '' },
            { signal_idx: 2, verdict: 'partial', comment: '' },
          ],
          final_answer_match: false,
          final_answer_comment: '',
          confidence: 0.5,
        }),
      }),
      imageFetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['student-photo-1', 'student-photo-2']);
    // Specifically NOT the prompt figure:
    expect(calls[0]).not.toContain('prompt-figure-1');
  });
});
