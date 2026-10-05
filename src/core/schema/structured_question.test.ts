import { describe, expect, it } from 'vitest';
import { extractAnswerHead } from './judge-routing';
import {
  BBox,
  FigureRef,
  PermanentError,
  RetryableError,
  StructuredQuestion,
  structuredToPromptMarkdown,
  structuredToReferenceMarkdown,
} from './structured_question';

describe('BBox', () => {
  it('accepts 0-1 normalized box', () => {
    const r = BBox.safeParse({ x: 0.1, y: 0.2, width: 0.6, height: 0.3 });
    expect(r.success).toBe(true);
  });

  it('rejects x > 1', () => {
    const r = BBox.safeParse({ x: 1.5, y: 0.2, width: 0.6, height: 0.3 });
    expect(r.success).toBe(false);
  });

  it('rejects negative width', () => {
    const r = BBox.safeParse({ x: 0.1, y: 0.2, width: -0.1, height: 0.3 });
    expect(r.success).toBe(false);
  });

  it('rejects width + x > 1', () => {
    const r = BBox.safeParse({ x: 0.5, y: 0.2, width: 0.6, height: 0.3 });
    expect(r.success).toBe(false);
  });
});

describe('FigureRef', () => {
  it('accepts a typical figure', () => {
    const r = FigureRef.safeParse({
      asset_id: 'asset_fig_1',
      role: 'diagram',
      source_page_index: 0,
      source_bbox: { x: 0.1, y: 0.5, width: 0.3, height: 0.2 },
      attached_to_index: 'q1',
      attach_confidence: 'high',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown attach_confidence', () => {
    const r = FigureRef.safeParse({
      asset_id: 'asset_fig_1',
      role: 'diagram',
      source_page_index: 0,
      source_bbox: { x: 0.1, y: 0.5, width: 0.3, height: 0.2 },
      attached_to_index: 'q1',
      attach_confidence: 'medium',
    });
    expect(r.success).toBe(false);
  });

  it('accepts manual reassignment with last_reassigned_at', () => {
    const r = FigureRef.safeParse({
      asset_id: 'asset_fig_1',
      role: 'diagram',
      source_page_index: 0,
      source_bbox: { x: 0.1, y: 0.5, width: 0.3, height: 0.2 },
      attached_to_index: 'q2',
      attach_confidence: 'manual',
      last_reassigned_at: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
});

describe('StructuredQuestion', () => {
  it('accepts a leaf standalone question', () => {
    const r = StructuredQuestion.safeParse({
      id: 'q1',
      role: 'standalone',
      question_no: '1',
      prompt_text: '题面',
      options: [
        { label: 'A', text: '甲' },
        { label: 'B', text: '乙' },
      ],
      answers: ['A'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a stem with sub_questions (recursive cloze tree)', () => {
    const r = StructuredQuestion.safeParse({
      id: 'stem1',
      role: 'stem',
      prompt_text: '阅读下文，填入合适的字。原文: 学而___习之',
      sub_questions: [
        {
          id: 'sub1',
          role: 'sub',
          question_no: '1',
          prompt_text: '第 1 空',
          options: [],
          answers: ['时'],
        },
        {
          id: 'sub2',
          role: 'sub',
          question_no: '2',
          prompt_text: '第 2 空',
          options: [],
          answers: ['不'],
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sub_questions).toHaveLength(2);
    }
  });

  it('rejects sub_questions on a leaf with role=standalone', () => {
    const r = StructuredQuestion.safeParse({
      id: 'q1',
      role: 'standalone',
      prompt_text: '题面',
      sub_questions: [{ id: 'sub1', role: 'sub', prompt_text: 'x' }],
    });
    // Standalone leaves should not have sub_questions; schema enforces this via refinement
    expect(r.success).toBe(false);
  });

  it('accepts extraction_evidence (handwriting + tencent_grading)', () => {
    const r = StructuredQuestion.safeParse({
      id: 'q1',
      role: 'standalone',
      prompt_text: '题面',
      answers: ['正确答案'],
      extraction_evidence: {
        handwriting: [{ text: '用户错答', bbox: { x: 0.5, y: 0.7, width: 0.2, height: 0.05 } }],
        tencent_grading: {
          IsCorrect: false,
          RightAnswer: '正确答案',
          AnswerAnalysis: '分析',
          KnowledgePoints: ['知识点1'],
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('source enum constrains provenance', () => {
    const r = StructuredQuestion.safeParse({
      id: 'q1',
      role: 'standalone',
      prompt_text: '题面',
      source: 'bogus_source',
    });
    expect(r.success).toBe(false);
  });
});

describe('structuredToPromptMarkdown', () => {
  it('renders a leaf question with options', () => {
    const md = structuredToPromptMarkdown({
      id: 'q1',
      role: 'standalone',
      question_no: '1',
      prompt_text: '下列哪个是正确的？',
      options: [
        { label: 'A', text: '甲' },
        { label: 'B', text: '乙' },
      ],
    });
    expect(md).toContain('1. 下列哪个是正确的？');
    expect(md).toContain('A. 甲');
    expect(md).toContain('B. 乙');
  });

  it('renders a stem with passage + sub_questions concatenated', () => {
    const md = structuredToPromptMarkdown({
      id: 'stem1',
      role: 'stem',
      prompt_text: '阅读: 学而___习之',
      sub_questions: [
        {
          id: 'sub1',
          role: 'sub',
          question_no: '1',
          prompt_text: '第 1 空',
        },
      ],
    });
    expect(md).toContain('阅读: 学而___习之');
    expect(md).toContain('1. 第 1 空');
  });

  it('omits options for question with no options', () => {
    const md = structuredToPromptMarkdown({
      id: 'q1',
      role: 'standalone',
      prompt_text: '简答题',
    });
    expect(md).toBe('简答题');
  });
});

describe('structuredToReferenceMarkdown', () => {
  it('renders answers + analysis if present', () => {
    const md = structuredToReferenceMarkdown({
      id: 'q1',
      role: 'standalone',
      prompt_text: '题面',
      answers: ['答案'],
      analysis: '解析过程',
    });
    expect(md).toContain('答案');
    expect(md).toContain('解析过程');
  });

  it('renders stem subs reference recursively', () => {
    const md = structuredToReferenceMarkdown({
      id: 'stem1',
      role: 'stem',
      prompt_text: '阅读',
      sub_questions: [
        { id: 'sub1', role: 'sub', question_no: '1', prompt_text: 'x', answers: ['ans1'] },
        { id: 'sub2', role: 'sub', question_no: '2', prompt_text: 'y', answers: ['ans2'] },
      ],
    });
    expect(md).toContain('ans1');
    expect(md).toContain('ans2');
  });

  // YUK-1011 codex P1 (round 2) — a leaf reference must resolve to its bare
  // answer head under extractAnswerHead (the exact judge's compare surface +
  // the write-path exact-capability guard share it). The analysis tail is
  // labeled 解析： so the cut is deterministic; a bare '\n'-joined analysis
  // would make the whole blob the head and grade correct answers incorrect.
  it('labels the analysis tail so extractAnswerHead resolves the bare answer', () => {
    const md = structuredToReferenceMarkdown({
      id: 'q1',
      role: 'sub',
      prompt_text: '「去」的意思是？',
      answers: ['B 离开'],
      analysis: '「去」在文言中常释为「离开」。',
    });
    expect(md).toBe('B 离开\n解析：「去」在文言中常释为「离开」。');
    expect(extractAnswerHead(md)).toBe('B 离开');
  });

  it('does not double-label an analysis that already carries a marker', () => {
    const md = structuredToReferenceMarkdown({
      id: 'q1',
      role: 'sub',
      prompt_text: '题面',
      answers: ['答案'],
      analysis: '【解析】已带标记',
    });
    expect(md).toBe('答案\n【解析】已带标记');
    expect(extractAnswerHead(md)).toBe('答案');
  });

  it('returns empty string for question with no answer / analysis', () => {
    const md = structuredToReferenceMarkdown({
      id: 'q1',
      role: 'standalone',
      prompt_text: '题面',
    });
    expect(md).toBe('');
  });
});

describe('RetryableError / PermanentError', () => {
  it('RetryableError captures cause and is instanceof Error', () => {
    const original = new Error('network timeout');
    const err = new RetryableError('Tencent OCR poll timeout', { cause: original });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.cause).toBe(original);
    expect(err.message).toContain('timeout');
  });

  it('PermanentError captures cause and is distinguishable from Retryable', () => {
    const original = new Error('invalid parameter');
    const err = new PermanentError('Bad request', { cause: original });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).not.toBeInstanceOf(RetryableError);
  });
});
