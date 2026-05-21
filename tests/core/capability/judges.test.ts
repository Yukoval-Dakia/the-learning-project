import { exactJudgeCapability } from '@/core/capability/judges/exact';
import { keywordJudgeCapability } from '@/core/capability/judges/keyword';
import { JudgeResultV2 } from '@/core/schema/capability';
import { judgeRouter, judgeRouterV2 } from '@/server/ai/judges';
import type { JudgeResult } from '@/server/ai/judges/exact';
import {
  type JudgeQuestionRow,
  judgeAnswer,
  resolveQuestionJudgeRoute,
} from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it, vi } from 'vitest';

describe('exactJudgeCapability', () => {
  it('has a valid manifest', () => {
    const manifest = exactJudgeCapability.manifest;
    expect(manifest.id).toBe('exact');
    expect(manifest.kind).toBe('judge');
    expect(manifest.cost_class).toBe('local');
    expect(manifest.latency_class).toBe('sync');
    expect(manifest.stability).toBe('stable');
  });

  it('returns correct for exact match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.confidence).toBe(1);
    expect(result.capability_ref.id).toBe('exact');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns incorrect for non-match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '实词' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('is case-insensitive', () => {
    const result = exactJudgeCapability.run({
      question: { reference: 'ABC' },
      answer: { content: 'abc' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });

  it('trims whitespace', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '  虚词  ' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('returns unsupported instead of throwing on invalid input', () => {
    const result = exactJudgeCapability.run({
      question: {},
      answer: { content: 'abc' },
    });

    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.feedback_md).toMatch(/reference/);
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('normalizes full-width characters before exact comparison', () => {
    const result = exactJudgeCapability.run({
      question: { reference: 'ＡＢＣ' },
      answer: { content: 'abc' },
    });

    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });
});

describe('judgeRouter compatibility bridge', () => {
  it('judgeRouter returns v1 shape for exact match', () => {
    const result: JudgeResult = judgeRouter({
      kind: 'exact',
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.verdict).toBe('correct');
    expect(result.score).toBe(1);
    expect(typeof result.feedback_md).toBe('string');
    expect(result.evidence_json).toBeDefined();
  });

  it('judgeRouter returns v1 shape for keyword', () => {
    const result = judgeRouter({
      kind: 'keyword',
      question: { keywords: ['abc'] },
      answer: { content: 'abc def' },
    });
    expect(result.verdict).toBe('correct');
  });

  it('judgeRouterV2 returns v2 shape for exact match', () => {
    const result = judgeRouterV2({
      kind: 'exact',
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref.id).toBe('exact');
    expect(result.confidence).toBe(1);
  });

  it('judgeRouterV2 returns v2 shape for keyword', () => {
    const result = judgeRouterV2({
      kind: 'keyword',
      question: { keywords: ['abc'] },
      answer: { content: 'abc def' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('keyword');
  });

  it('downgrades unsupported v2 results to v1 incorrect without throwing', () => {
    const result = judgeRouter({
      kind: 'exact',
      question: {},
      answer: { content: 'abc' },
    });

    expect(result.verdict).toBe('incorrect');
    expect(result.score).toBe(0);
    expect(result.feedback_md).toMatch(/reference/);
  });

  it('unimplemented judge kinds still throw', () => {
    expect(() =>
      judgeRouter({
        kind: 'semantic',
        question: {},
        answer: { content: '' },
      }),
    ).toThrow(/not implemented|not found/i);
  });
});

describe('keywordJudgeCapability', () => {
  it('has a valid manifest', () => {
    const manifest = keywordJudgeCapability.manifest;
    expect(manifest.id).toBe('keyword');
    expect(manifest.kind).toBe('judge');
    expect(manifest.cost_class).toBe('local');
    expect(manifest.stability).toBe('stable');
  });

  it('returns correct when all keywords hit', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词'] },
      answer: { content: '虚词是一种代词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref.id).toBe('keyword');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns partial for some keyword hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词', '连词'] },
      answer: { content: '虚词和代词分析' },
    });
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBeCloseTo(2 / 3);
  });

  it('returns incorrect for zero hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词'] },
      answer: { content: '完全无关' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('keeps low keyword hit ratios incorrect', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['a', 'b', 'c', 'd', 'e'] },
      answer: { content: 'a only' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
    expect(result.evidence_json.hits).toEqual(['a']);
    expect(result.evidence_json.total).toBe(5);
  });

  it('returns correct at 85% threshold', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      answer: { content: 'a b c d e f missing_last' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('returns unsupported when keywords are missing or empty', () => {
    for (const question of [{}, { keywords: [] }]) {
      const result = keywordJudgeCapability.run({
        question,
        answer: { content: 'abc' },
      });

      expect(result.coarse_outcome).toBe('unsupported');
      expect(result.score).toBeNull();
      expect(result.feedback_md).toMatch(/keywords|关键词/);
      expect(JudgeResultV2.safeParse(result).success).toBe(true);
    }
  });

  it('normalizes full-width keyword characters', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['ＡＢＣ'] },
      answer: { content: 'abc def' },
    });

    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });
});

describe('question contract routing', () => {
  const profile = resolveSubjectProfile('wenyan');
  const baseQuestion: JudgeQuestionRow = {
    id: 'q1',
    kind: 'fill_blank',
    prompt_md: '填空',
    reference_md: '答案',
    rubric_json: null,
    choices_md: null,
    judge_kind_override: null,
  };

  it('selects route by override, kind, and rubric contract', () => {
    expect(
      resolveQuestionJudgeRoute(
        { ...baseQuestion, kind: 'choice', choices_md: ['A', 'B'], reference_md: 'A' },
        profile,
      ),
    ).toBe('exact');
    expect(
      resolveQuestionJudgeRoute(
        {
          ...baseQuestion,
          kind: 'fill_blank',
          rubric_json: {
            criteria: [{ name: 'correctness', weight: 1, descriptor: 'hit terms' }],
            keywords: ['虚词'],
          },
        },
        profile,
      ),
    ).toBe('keyword');
    expect(resolveQuestionJudgeRoute({ ...baseQuestion, kind: 'translation' }, profile)).toBe(
      'semantic',
    );
    expect(
      resolveQuestionJudgeRoute(
        { ...baseQuestion, kind: 'short_answer', judge_kind_override: 'keyword' },
        profile,
      ),
    ).toBe('keyword');
  });

  it('does not map unsupported judge results to failure semantics', async () => {
    const result = await judgeAnswer({
      db: {} as never,
      question: { ...baseQuestion, kind: 'short_answer', judge_kind_override: 'steps' },
      answer_md: '答案',
      subjectProfile: profile,
    });

    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.score).toBeNull();
  });

  it('parses semantic judge correct, partial, and incorrect outputs', async () => {
    const question: JudgeQuestionRow = {
      ...baseQuestion,
      kind: 'short_answer',
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: 'core points' }],
        required_points: ['指出之是代词', '说明指代前文'],
      },
    };
    const runTaskFn = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0.9,
          coarse_outcome: 'correct',
          confidence: 0.8,
          feedback_md: '要点完整。',
          evidence_json: { matched_points: ['指出之是代词'], missing_points: [] },
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0.5,
          coarse_outcome: 'partial',
          confidence: 0.7,
          feedback_md: '答到一部分。',
          evidence_json: { matched_points: ['指出之是代词'], missing_points: ['说明指代前文'] },
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          score: 0,
          coarse_outcome: 'incorrect',
          confidence: 0.9,
          feedback_md: '未命中核心要点。',
          evidence_json: { matched_points: [], missing_points: ['指出之是代词'] },
        }),
      });

    await expect(
      judgeAnswer({
        db: {} as never,
        question,
        answer_md: '代词',
        subjectProfile: profile,
        runTaskFn,
      }),
    ).resolves.toMatchObject({ result: { coarse_outcome: 'correct' } });
    await expect(
      judgeAnswer({
        db: {} as never,
        question,
        answer_md: '代词',
        subjectProfile: profile,
        runTaskFn,
      }),
    ).resolves.toMatchObject({ result: { coarse_outcome: 'partial' } });
    await expect(
      judgeAnswer({
        db: {} as never,
        question,
        answer_md: '不知道',
        subjectProfile: profile,
        runTaskFn,
      }),
    ).resolves.toMatchObject({ result: { coarse_outcome: 'incorrect' } });
  });

  it('turns malformed semantic output and provider failure into unsupported', async () => {
    const question: JudgeQuestionRow = {
      ...baseQuestion,
      kind: 'short_answer',
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: 'core points' }],
        required_points: ['指出之是代词'],
      },
    };
    const malformed = await judgeAnswer({
      db: {} as never,
      question,
      answer_md: '代词',
      subjectProfile: profile,
      runTaskFn: vi.fn().mockResolvedValue({ text: 'not json' }),
    });
    expect(malformed.result.coarse_outcome).toBe('unsupported');

    const failed = await judgeAnswer({
      db: {} as never,
      question,
      answer_md: '代词',
      subjectProfile: profile,
      runTaskFn: vi.fn().mockRejectedValue(new Error('provider down')),
    });
    expect(failed.result.coarse_outcome).toBe('unsupported');
  });
});
