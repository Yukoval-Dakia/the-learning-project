// YUK-216 S2 slice 2 — SourcedQuestion / SourcingTaskOutput unit tests.
//
// Pure schema parse coverage (no DB). Lands in the unit partition via the
// src/core/** fastTestInclude glob.
import { describe, expect, it } from 'vitest';
import { SourcedQuestion, SourcingTaskOutput } from './sourcing';

const validQuestion = {
  kind: 'short_answer',
  prompt_md: '请翻译「学而时习之，不亦说乎」。',
  reference_md: '学习并按时温习它，不也很愉快吗？',
  judge_kind_override: 'semantic',
  rubric_json: {
    criteria: [{ name: 'correctness', weight: 1, descriptor: '译文准确' }],
    required_points: ['学习', '按时温习', '愉快'],
  },
  difficulty: 2,
  knowledge_ids: ['k_lunyu_xueer'],
  source_url: 'https://example.edu/wenyan/lunyu',
  source_title: '论语·学而 注疏',
};

describe('SourcedQuestion', () => {
  it('accepts a well-formed sourced question', () => {
    const parsed = SourcedQuestion.safeParse(validQuestion);
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional extraction_hash', () => {
    const parsed = SourcedQuestion.safeParse({ ...validQuestion, extraction_hash: 'sha256:abc' });
    expect(parsed.success).toBe(true);
  });

  it('requires a valid source_url (tier-2 provenance anchor)', () => {
    const parsed = SourcedQuestion.safeParse({ ...validQuestion, source_url: 'not-a-url' });
    expect(parsed.success).toBe(false);
  });

  it('requires a non-empty source_title', () => {
    const parsed = SourcedQuestion.safeParse({ ...validQuestion, source_title: '' });
    expect(parsed.success).toBe(false);
  });

  it.each(['exact', 'keyword', 'semantic'])(
    'accepts runnable judge_kind_override %s',
    (judge) => {
      const parsed = SourcedQuestion.safeParse({ ...validQuestion, judge_kind_override: judge });
      expect(parsed.success).toBe(true);
    },
  );

  it.each(['steps', 'unit_dimension', 'rubric', 'multimodal_direct'])(
    'rejects non-runnable judge_kind_override %s (same constraint as QuizGenQuestion)',
    (judge) => {
      const parsed = SourcedQuestion.safeParse({ ...validQuestion, judge_kind_override: judge });
      expect(parsed.success).toBe(false);
    },
  );

  it('rejects an out-of-range difficulty', () => {
    const parsed = SourcedQuestion.safeParse({ ...validQuestion, difficulty: 9 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown question kind', () => {
    const parsed = SourcedQuestion.safeParse({ ...validQuestion, kind: 'mystery' });
    expect(parsed.success).toBe(false);
  });
});

describe('SourcingTaskOutput', () => {
  const validOutput = {
    questions: [validQuestion],
    query_plan: ['论语 学而 翻译题', '文言文 虚词 练习'],
    fetched_at: '2026-06-06T00:00:00.000Z',
    tool: 'tavily',
  };

  it('accepts a well-formed output batch', () => {
    const parsed = SourcingTaskOutput.safeParse(validOutput);
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty questions array', () => {
    const parsed = SourcingTaskOutput.safeParse({ ...validOutput, questions: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects more than 10 questions', () => {
    const parsed = SourcingTaskOutput.safeParse({
      ...validOutput,
      questions: Array.from({ length: 11 }, () => validQuestion),
    });
    expect(parsed.success).toBe(false);
  });

  it("pins tool to the literal 'tavily'", () => {
    const parsed = SourcingTaskOutput.safeParse({ ...validOutput, tool: 'serpapi' });
    expect(parsed.success).toBe(false);
  });

  it('requires a non-empty fetched_at', () => {
    const parsed = SourcingTaskOutput.safeParse({ ...validOutput, fetched_at: '' });
    expect(parsed.success).toBe(false);
  });
});
