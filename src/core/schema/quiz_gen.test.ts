import { describe, expect, it } from 'vitest';
import { QuestionSource } from './business';
import { QuizGenMetadata, QuizGenOutput, QuizGenSourceRef } from './quiz_gen';

describe('QuestionSource enum', () => {
  it("includes 'quiz_gen' (search-grounded QuizGen wave §2)", () => {
    expect(QuestionSource.options).toContain('quiz_gen');
    expect(() => QuestionSource.parse('quiz_gen')).not.toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() => QuestionSource.parse('not_a_source')).toThrow();
  });
});

const validSourceRef = {
  url: 'https://example.com/han-history',
  title: '汉代历史概述',
  snippet: '汉朝建立于公元前 202 年。',
  used_for: 'fact' as const,
  extracted: true,
};

const validSourcePack = {
  query_plan: ['汉朝建立时间', '楚汉之争结果'],
  searched_at: '2026-06-02T10:00:00Z',
  tool: 'tavily' as const,
};

const validCopySafety = {
  verdict: 'original' as const,
  max_overlap: 0.12,
  checked_by: 'agent_self' as const,
};

const validQuestion = {
  kind: 'choice' as const,
  prompt_md: '汉朝建立于哪一年？',
  reference_md: '公元前 202 年',
  choices_md: ['公元前 202 年', '公元前 221 年', '公元 9 年'],
  judge_kind_override: 'exact' as const,
  rubric_json: { criteria: [{ name: 'correctness', weight: 1, descriptor: '选对即满分' }] },
  difficulty: 2,
  knowledge_ids: ['k_han'],
  source_refs: [validSourceRef],
};

describe('QuizGenSourceRef', () => {
  it('parses a valid source ref', () => {
    const parsed = QuizGenSourceRef.parse(validSourceRef);
    expect(parsed.used_for).toBe('fact');
    expect(parsed.extracted).toBe(true);
  });

  it('allows snippet to be omitted', () => {
    const { snippet: _snippet, ...rest } = validSourceRef;
    expect(() => QuizGenSourceRef.parse(rest)).not.toThrow();
  });

  it('rejects a non-URL url', () => {
    expect(() => QuizGenSourceRef.parse({ ...validSourceRef, url: 'not-a-url' })).toThrow();
  });

  it('rejects an unknown used_for', () => {
    expect(() => QuizGenSourceRef.parse({ ...validSourceRef, used_for: 'other' })).toThrow();
  });
});

describe('QuizGenMetadata', () => {
  it('parses a ready metadata block without verification', () => {
    const parsed = QuizGenMetadata.parse({
      source_pack: validSourcePack,
      source_refs: [validSourceRef],
      generation_method: 'search_grounded',
      copy_safety: validCopySafety,
      generation_status: 'ready',
    });
    expect(parsed.generation_status).toBe('ready');
    expect(parsed.verification).toBeUndefined();
  });

  it('parses metadata carrying a two-axis verification', () => {
    const parsed = QuizGenMetadata.parse({
      source_pack: validSourcePack,
      source_refs: [validSourceRef],
      generation_method: 'search_grounded',
      copy_safety: { ...validCopySafety, checked_by: 'quiz_verify' },
      generation_status: 'ready',
      verification: {
        status: 'verified',
        summary: '事实正确，措辞原创。',
        verified_by: { by: 'ai', task_kind: 'QuizVerifyTask' },
      },
    });
    expect(parsed.verification?.status).toBe('verified');
    expect(parsed.verification?.verified_by.by).toBe('ai');
  });

  it('rejects a generation_status other than ready', () => {
    expect(() =>
      QuizGenMetadata.parse({
        source_pack: validSourcePack,
        source_refs: [],
        generation_method: 'closed_book',
        copy_safety: validCopySafety,
        generation_status: 'pending',
      }),
    ).toThrow();
  });
});

describe('QuizGenOutput', () => {
  it('parses a valid agent output with one question', () => {
    const parsed = QuizGenOutput.parse({
      questions: [validQuestion],
      source_pack: validSourcePack,
      generation_method: 'search_grounded',
      self_copy_safety: validCopySafety,
    });
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0].source_refs[0].url).toContain('example.com');
    expect(parsed.questions[0].knowledge_ids).toEqual(['k_han']);
  });

  it('parses a prose question that omits choices/rubric', () => {
    const parsed = QuizGenOutput.parse({
      questions: [
        {
          kind: 'short_answer',
          prompt_md: '简述楚汉之争的结果。',
          reference_md: '刘邦击败项羽，建立汉朝。',
          difficulty: 3,
          knowledge_ids: ['k_chuhan'],
          source_refs: [validSourceRef],
        },
      ],
      source_pack: validSourcePack,
      generation_method: 'search_grounded',
      self_copy_safety: validCopySafety,
    });
    expect(parsed.questions[0].kind).toBe('short_answer');
    expect(parsed.questions[0].choices_md).toBeUndefined();
  });

  it('rejects an empty questions array', () => {
    expect(() =>
      QuizGenOutput.parse({
        questions: [],
        source_pack: validSourcePack,
        generation_method: 'search_grounded',
        self_copy_safety: validCopySafety,
      }),
    ).toThrow();
  });

  it('rejects a difficulty out of 1-5', () => {
    expect(() =>
      QuizGenOutput.parse({
        questions: [{ ...validQuestion, difficulty: 7 }],
        source_pack: validSourcePack,
        generation_method: 'search_grounded',
        self_copy_safety: validCopySafety,
      }),
    ).toThrow();
  });

  it('rejects an unknown generation_method', () => {
    expect(() =>
      QuizGenOutput.parse({
        questions: [validQuestion],
        source_pack: validSourcePack,
        generation_method: 'magic',
        self_copy_safety: validCopySafety,
      }),
    ).toThrow();
  });

  it('rejects a search_grounded question with empty source_refs (§0 provenance)', () => {
    expect(() =>
      QuizGenOutput.parse({
        questions: [{ ...validQuestion, source_refs: [] }],
        source_pack: validSourcePack,
        generation_method: 'search_grounded',
        self_copy_safety: validCopySafety,
      }),
    ).toThrow(/source_ref/);
  });

  it('allows a closed_book question with empty source_refs', () => {
    const parsed = QuizGenOutput.parse({
      questions: [{ ...validQuestion, source_refs: [] }],
      source_pack: validSourcePack,
      generation_method: 'closed_book',
      self_copy_safety: { verdict: 'unknown' as const, checked_by: 'agent_self' as const },
    });
    expect(parsed.questions[0].source_refs).toEqual([]);
  });

  it('rejects a non-runnable judge_kind_override (rubric has no runner)', () => {
    expect(() =>
      QuizGenOutput.parse({
        questions: [{ ...validQuestion, judge_kind_override: 'rubric' }],
        source_pack: validSourcePack,
        generation_method: 'search_grounded',
        self_copy_safety: validCopySafety,
      }),
    ).toThrow();
  });
});
