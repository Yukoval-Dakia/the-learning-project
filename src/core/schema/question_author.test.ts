// ADR-0031 / YUK-304 (lane B) — QuestionAuthorDraft schema + the server-side
// normalization barrier (normalizeAuthorStructured). Pure unit (no DB).
import { describe, expect, it } from 'vitest';
import { QuestionAuthorDraft, normalizeAuthorStructured } from './question_author';
import type { StructuredQuestionT } from './structured_question';

const standalone: StructuredQuestionT = {
  id: 'llm_1',
  role: 'standalone',
  prompt_text: '解释「之」在「学而时习之」中的用法。',
  answers: ['代词，指代所学的内容。'],
  analysis: '「之」承前指代，非结构助词。',
};

const stemTree: StructuredQuestionT = {
  id: 'llm_root',
  role: 'stem',
  prompt_text: '阅读下面的文段：子曰：「学而时习之，不亦说乎？」',
  sub_questions: [
    {
      id: 'llm_s1',
      role: 'sub',
      question_no: '1',
      prompt_text: '「说」在句中是什么意思？',
      answers: ['通「悦」，高兴。'],
    },
    {
      id: 'llm_s2',
      role: 'sub',
      question_no: '2',
      prompt_text: '翻译整句。',
      answers: ['学了又按时温习，不也很高兴吗？'],
      analysis: '注意「时」作状语。',
    },
  ],
};

describe('QuestionAuthorDraft schema', () => {
  it('accepts a standalone draft', () => {
    const parsed = QuestionAuthorDraft.parse({
      kind: 'short_answer',
      difficulty: 3,
      knowledge_ids: ['k_zhi'],
      structured: standalone,
    });
    expect(parsed.kind).toBe('short_answer');
    expect(parsed.structured.role).toBe('standalone');
  });

  it('accepts a 材料 stem + sub_questions tree (YUK-302 composite shape)', () => {
    const parsed = QuestionAuthorDraft.parse({
      kind: 'reading',
      difficulty: 4,
      knowledge_ids: ['k_lunyu'],
      structured: stemTree,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '答出通假与翻译要点' }],
        required_points: ['通「悦」', '按时温习'],
      },
    });
    expect(parsed.structured.sub_questions).toHaveLength(2);
  });

  it('rejects out-of-enum judge routes and a sub_questions-bearing standalone', () => {
    expect(() =>
      QuestionAuthorDraft.parse({
        kind: 'short_answer',
        difficulty: 3,
        knowledge_ids: ['k'],
        structured: standalone,
        judge_kind_override: 'rubric',
      }),
    ).toThrow();
    // StructuredQuestion refine: only stem may carry sub_questions.
    expect(() =>
      QuestionAuthorDraft.parse({
        kind: 'short_answer',
        difficulty: 3,
        knowledge_ids: ['k'],
        structured: { ...standalone, sub_questions: [stemTree.sub_questions?.[0]] },
      }),
    ).toThrow();
  });
});

describe('normalizeAuthorStructured — server-side hardening (critic #6)', () => {
  it('regenerates every node id regardless of what the LLM emitted', () => {
    let n = 0;
    const genId = () => `srv_${++n}`;
    const result = normalizeAuthorStructured(stemTree, genId);
    expect(result.structured.id).toBe('srv_1');
    expect(result.structured.sub_questions?.map((s) => s.id)).toEqual(['srv_2', 'srv_3']);
    // Duplicate / hallucinated LLM ids can never survive.
    const dupTree: StructuredQuestionT = {
      ...stemTree,
      sub_questions: stemTree.sub_questions?.map((s) => ({ ...s, id: 'same' })),
    };
    const dedup = normalizeAuthorStructured(dupTree, genId);
    const ids = [dedup.structured.id, ...(dedup.structured.sub_questions?.map((s) => s.id) ?? [])];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives prompt_md / reference_md via the shared OCR-import derivation', () => {
    const result = normalizeAuthorStructured(stemTree, () => 'x');
    expect(result.prompt_md).toContain('阅读下面的文段');
    expect(result.prompt_md).toContain('翻译整句');
    expect(result.reference_md).toContain('通「悦」');
    expect(result.reference_md).toContain('按时温习');
  });

  it("rejects a root role 'sub'", () => {
    expect(() => normalizeAuthorStructured({ ...standalone, role: 'sub' }, () => 'x')).toThrow(
      /root node/,
    );
  });

  it('rejects a stem with zero sub_questions', () => {
    expect(() =>
      normalizeAuthorStructured(
        { id: 'r', role: 'stem', prompt_text: '材料', sub_questions: [] },
        () => 'x',
      ),
    ).toThrow(/at least one sub_question/);
  });

  it("rejects a stem child whose role is not 'sub'", () => {
    expect(() =>
      normalizeAuthorStructured(
        {
          id: 'r',
          role: 'stem',
          prompt_text: '材料',
          sub_questions: [{ ...standalone }],
        },
        () => 'x',
      ),
    ).toThrow(/role 'sub'/);
  });

  it('rejects empty prompt_text and reference-less leaves (empty derived md discipline)', () => {
    expect(() =>
      normalizeAuthorStructured({ ...standalone, prompt_text: '   ' }, () => 'x'),
    ).toThrow(/prompt_text/);
    expect(() =>
      normalizeAuthorStructured(
        { ...standalone, answers: undefined, analysis: undefined },
        () => 'x',
      ),
    ).toThrow(/answers and\/or analysis/);
    expect(() =>
      normalizeAuthorStructured(
        {
          id: 'r',
          role: 'stem',
          prompt_text: '材料',
          sub_questions: [
            { id: 's', role: 'sub', prompt_text: '问', answers: [] /* no analysis */ },
          ],
        },
        () => 'x',
      ),
    ).toThrow(/answers and\/or analysis/);
  });
});
