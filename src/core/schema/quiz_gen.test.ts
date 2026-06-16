import { describe, expect, it } from 'vitest';
import { QuestionSource } from './business';
import {
  QuizGenGenerationMethod,
  QuizGenMaterial,
  QuizGenMetadata,
  QuizGenOutput,
  QuizGenSourceRef,
  QuizVerificationResult,
} from './quiz_gen';

describe('QuestionSource enum', () => {
  it("includes 'quiz_gen' (search-grounded QuizGen wave §2)", () => {
    expect(QuestionSource.options).toContain('quiz_gen');
    expect(() => QuestionSource.parse('quiz_gen')).not.toThrow();
  });

  it("includes 'web_sourced' (YUK-216 S2 tier 2)", () => {
    expect(QuestionSource.options).toContain('web_sourced');
    expect(() => QuestionSource.parse('web_sourced')).not.toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() => QuestionSource.parse('not_a_source')).toThrow();
  });
});

describe('QuizGenGenerationMethod enum', () => {
  it("includes 'material_grounded' (YUK-216 S2 tier 3)", () => {
    expect(QuizGenGenerationMethod.options).toContain('material_grounded');
    expect(() => QuizGenGenerationMethod.parse('material_grounded')).not.toThrow();
  });

  it("keeps the prior 'search_grounded' / 'closed_book' values", () => {
    expect(QuizGenGenerationMethod.options).toEqual(
      expect.arrayContaining(['search_grounded', 'closed_book', 'material_grounded']),
    );
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

describe('QuizGenMaterial (YUK-224 tier 3)', () => {
  const validMaterial = {
    body_md: '汉朝由刘邦建立于公元前 202 年。',
    url: 'https://example.edu/han/founding',
    title: '汉朝的建立',
    fetched_at: '2026-06-06T10:00:00.000Z',
  };

  it('parses a valid material block', () => {
    const parsed = QuizGenMaterial.parse(validMaterial);
    expect(parsed.body_md).toContain('公元前 202 年');
    expect(parsed.title).toBe('汉朝的建立');
  });

  it('rejects an empty body_md', () => {
    expect(() => QuizGenMaterial.parse({ ...validMaterial, body_md: '' })).toThrow();
  });

  it('rejects a non-URL url', () => {
    expect(() => QuizGenMaterial.parse({ ...validMaterial, url: 'not-a-url' })).toThrow();
  });
});

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

  it('accepts an optional material_source_document_id (YUK-216 S2 tier 3)', () => {
    const parsed = QuizGenMetadata.parse({
      source_pack: validSourcePack,
      source_refs: [validSourceRef],
      generation_method: 'material_grounded',
      copy_safety: validCopySafety,
      generation_status: 'ready',
      material_source_document_id: 'doc_passage_1',
    });
    expect(parsed.material_source_document_id).toBe('doc_passage_1');
  });

  it('leaves material_source_document_id undefined when omitted (non-material method)', () => {
    const parsed = QuizGenMetadata.parse({
      source_pack: validSourcePack,
      source_refs: [validSourceRef],
      generation_method: 'search_grounded',
      copy_safety: validCopySafety,
      generation_status: 'ready',
    });
    expect(parsed.material_source_document_id).toBeUndefined();
  });

  it('rejects material_grounded WITHOUT material_source_document_id (YUK-224 time-order guard)', () => {
    const result = QuizGenMetadata.safeParse({
      source_pack: validSourcePack,
      source_refs: [validSourceRef],
      generation_method: 'material_grounded',
      copy_safety: validCopySafety,
      generation_status: 'ready',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['material_source_document_id']);
    }
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

  it('rejects material_grounded WITHOUT a material block (YUK-224 正向校验, replaces PR #312 V1 时序守卫)', () => {
    const result = QuizGenOutput.safeParse({
      questions: [validQuestion],
      source_pack: validSourcePack,
      generation_method: 'material_grounded',
      self_copy_safety: validCopySafety,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('material'))).toBe(true);
      expect(result.error.issues.some((i) => i.message.includes('YUK-224'))).toBe(true);
    }
  });

  it('accepts material_grounded WITH a material block (real passage + URL)', () => {
    const parsed = QuizGenOutput.parse({
      questions: [
        {
          ...validQuestion,
          kind: 'reading' as const,
          prompt_md: '阅读下面短文，回答：汉朝建立于哪一年？',
          judge_kind_override: 'semantic' as const,
          rubric_json: {
            criteria: [{ name: 'correctness', weight: 1, descriptor: '答对建立年份' }],
            required_points: ['公元前 202 年'],
          },
        },
      ],
      source_pack: validSourcePack,
      generation_method: 'material_grounded',
      self_copy_safety: validCopySafety,
      material: {
        body_md: '汉朝由刘邦建立于公元前 202 年，定都长安……',
        url: 'https://example.edu/han/founding',
        title: '汉朝的建立',
        fetched_at: '2026-06-06T10:00:00.000Z',
      },
    });
    expect(parsed.generation_method).toBe('material_grounded');
    expect(parsed.material?.body_md).toContain('公元前 202 年');
    expect(parsed.material?.url).toContain('example.edu');
  });

  it('allows search_grounded to omit the material block', () => {
    const parsed = QuizGenOutput.parse({
      questions: [validQuestion],
      source_pack: validSourcePack,
      generation_method: 'search_grounded',
      self_copy_safety: validCopySafety,
    });
    expect(parsed.material).toBeUndefined();
  });

  it('rejects a material block with a non-URL url', () => {
    const result = QuizGenOutput.safeParse({
      questions: [validQuestion],
      source_pack: validSourcePack,
      generation_method: 'material_grounded',
      self_copy_safety: validCopySafety,
      material: {
        body_md: '一段真实素材原文。',
        url: 'not-a-url',
        title: '素材',
        fetched_at: '2026-06-06T10:00:00.000Z',
      },
    });
    expect(result.success).toBe(false);
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

// YUK-350 (RL1, Plan B) — the LLM-parse `overall` enum must stay 3-value so the model
// can never self-report a system 'error'. The 4-value result-layer projection lives in
// the QuizVerifyOverall type (handler/event), NOT in this parse schema.
describe('QuizVerificationResult.overall (RL1 enum boundary)', () => {
  const baseVerify = {
    grounding: { verdict: 'pass' as const, note: 'grounded' },
    copy_safety: { verdict: 'original' as const, max_overlap: 0.1 },
    knowledge_hit: { verdict: 'pass' as const, note: 'on target' },
    summary_md: '复核结论：pass',
    confidence: 0.8,
  };

  it('exhaustiveness: accepts exactly the 3 legal model verdicts (pass|needs_review|fail)', () => {
    for (const overall of ['pass', 'needs_review', 'fail'] as const) {
      const parsed = QuizVerificationResult.safeParse({ ...baseVerify, overall });
      expect(parsed.success).toBe(true);
    }
    // The enum lists exactly these three options — regression pin so widening it to
    // carry 'error' (which would let the model self-report a system failure) fails.
    expect(QuizVerificationResult.shape.overall.options).toEqual(['pass', 'needs_review', 'fail']);
  });

  it("REJECTS overall='error' (model cannot self-report a system-error class)", () => {
    const parsed = QuizVerificationResult.safeParse({ ...baseVerify, overall: 'error' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown overall value', () => {
    expect(QuizVerificationResult.safeParse({ ...baseVerify, overall: 'maybe' }).success).toBe(
      false,
    );
  });
});
