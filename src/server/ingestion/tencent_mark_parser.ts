import type { BBoxT, StructuredQuestionT } from '@/core/schema/structured_question';
import { createId } from '@paralleldrive/cuid2';

// DUAL-ENGINE (YUK-253): GLM-OCR is the default extraction engine; this
// Tencent parser is RETAINED PERMANENTLY as the `EXTRACT_OCR_ENGINE='tencent'`
// switchable engine — owner decision 2026-06-07: 腾讯支持长期保留，不删。
// No removal planned. Dual engines also enable same-page A/B quality
// comparison and per-scenario switching (规范试卷场景可切回腾讯切题/解析).

/**
 * Parser for Tencent QuestionMarkAgent DONE response → 系统内 StructuredQuestion 树。
 *
 * 输入：Tencent DescribeQuestionMarkAgentJob 的 raw 响应（JobStatus='DONE'）。
 * 输出：StructuredQuestion[] + figures bbox 信息 + layout_quality + warnings。
 *
 * 见 Sub 0c plan Step 7 + spec § 1.6 + ADR-0002 修订（extraction_evidence 概念）。
 */

export type PageMeta = {
  pageWidth: number;
  pageHeight: number;
  pageIndex?: number;
};

export type ParsedFigureBox = {
  bbox: BBoxT;
  source_page_index: number;
};

export type LayoutQuality = 'structured' | 'partial' | 'text_only';

export type ParseResult = {
  questions: StructuredQuestionT[];
  figures: ParsedFigureBox[];
  layout_quality: LayoutQuality;
  warnings: string[];
};

// ---------- 几何 ----------

/**
 * 8-flat-array (Tencent QuestionPositions / HandwriteInfoPositions) → 0-1 normalized BBox.
 * 输入是 [x1,y1, x2,y2, x3,y3, x4,y4]（顺时针四角），取 axis-aligned 包围盒。
 */
export function flat8ToBBox(flat: number[], pageWidth: number, pageHeight: number): BBoxT {
  if (flat.length !== 8) {
    throw new Error(`flat8ToBBox: expected 8 numbers, got ${flat.length}`);
  }
  const xs = [flat[0], flat[2], flat[4], flat[6]];
  const ys = [flat[1], flat[3], flat[5], flat[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: clamp01(minX / pageWidth),
    y: clamp01(minY / pageHeight),
    width: clamp01((maxX - minX) / pageWidth),
    height: clamp01((maxY - minY) / pageHeight),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ---------- Title parsing ----------

export type ParsedSubTitle = {
  question_no?: string;
  prompt_text: string;
  options: { label: string; text: string }[];
};

const OPTION_LINE = /^([A-Z])\.\s*(.*)$/;
const SUB_LEADING_NUM = /^(\d+)\.\s*(.*)$/;

/**
 * Parse a sub-question MarkItemTitle like:
 *   "1. ______\nA. decision\nB. reason\nC. difference\nD. choice"
 * → { question_no: '1', prompt_text: '______', options: [{A,decision}, ...] }
 */
export function parseSubMarkItemTitle(title: string): ParsedSubTitle {
  const lines = title.split('\n').map((l) => l.trim());
  let question_no: string | undefined;
  let prompt_text = '';
  const options: { label: string; text: string }[] = [];

  if (lines.length === 0) {
    return { prompt_text: '', options: [] };
  }

  const first = lines[0] ?? '';
  const numMatch = first.match(SUB_LEADING_NUM);
  if (numMatch) {
    question_no = numMatch[1];
    prompt_text = numMatch[2] ?? '';
  } else {
    prompt_text = first;
  }

  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(OPTION_LINE);
    if (m) {
      options.push({ label: m[1], text: m[2] });
    } else if (lines[i]) {
      // 续行 —— 拼到 prompt_text
      prompt_text = `${prompt_text}\n${lines[i]}`.trim();
    }
  }

  return { question_no, prompt_text, options };
}

/**
 * Parse a stem MarkItemTitle —— 整段 passage 当 prompt_text。不二次拆 blanks，
 * 由调用方 / 渲染层处理 inline `\d+\. ___` 占位。
 */
export function parseStemMarkItemTitle(title: string): { prompt_text: string } {
  return { prompt_text: title };
}

// ---------- Layout quality heuristic ----------

const STEM_BLANK = /(\d+)\.\s*_+/g;

function detectLayoutQuality(
  stemText: string,
  subCount: number,
): { quality: LayoutQuality; warnings: string[] } {
  const warnings: string[] = [];

  if (subCount === 0) {
    return { quality: 'text_only', warnings: ['no sub questions detected'] };
  }

  const blanks = [...stemText.matchAll(STEM_BLANK)];
  if (blanks.length === 0) {
    // stem 没有 blank pattern —— 可能是阅读理解风格，sub 自己有完整 prompt
    return { quality: 'structured', warnings: [] };
  }

  if (blanks.length !== subCount) {
    warnings.push(
      `stem 含 ${blanks.length} 个 blank pattern，但仅 ${subCount} 个 sub question —— layout 不完整`,
    );
    return { quality: 'partial', warnings };
  }

  return { quality: 'structured', warnings: [] };
}

// ---------- Main entry point ----------

type AnswerInfoRaw = {
  RightAnswer?: string;
  HandwriteInfo?: string;
  HandwriteInfoPositions?: number[];
  IsCorrect?: boolean;
  AnswerAnalysis?: string;
  KnowledgePoints?: string[];
};

type MarkInfoNode = {
  MarkItemTitle?: string;
  QuestionPositions?: number[];
  QuestionImagePositions?: QuestionImagePositionRaw[];
  AnswerInfos?: AnswerInfoRaw[];
  MarkInfos?: MarkInfoNode[];
  RightAnswer?: string;
};

type QuestionImagePositionRaw = number[] | { Position?: number[] };

type MarkAgentRawResponse = {
  JobStatus?: string;
  MarkInfos?: MarkInfoNode[];
  ErrorCode?: string;
  ErrorMessage?: string;
};

export function parseMarkAgentResponse(raw: MarkAgentRawResponse, pageMeta: PageMeta): ParseResult {
  const pageIndex = pageMeta.pageIndex ?? 0;
  const questions: StructuredQuestionT[] = [];
  const figures: ParsedFigureBox[] = [];
  const warnings: string[] = [];

  const topLevel = raw.MarkInfos ?? [];

  for (const node of topLevel) {
    const isStem = (node.MarkInfos?.length ?? 0) > 0;
    if (isStem) {
      const stem = nodeToStem(node, pageMeta, figures, pageIndex);
      questions.push(stem);
    } else {
      const standalone = nodeToLeaf(node, pageMeta, figures, pageIndex, 'standalone');
      questions.push(standalone);
    }
  }

  // 启发 layout_quality
  let quality: LayoutQuality = 'structured';
  for (const q of questions) {
    if (q.role === 'stem' && q.sub_questions) {
      const r = detectLayoutQuality(q.prompt_text, q.sub_questions.length);
      if (r.quality !== 'structured') {
        quality = r.quality;
        warnings.push(...r.warnings);
      }
    }
  }
  if (questions.length === 0) {
    quality = 'text_only';
    warnings.push('Mark Agent 返回 0 个题目');
  }

  return { questions, figures, layout_quality: quality, warnings };
}

function nodeToStem(
  node: MarkInfoNode,
  pageMeta: PageMeta,
  figuresOut: ParsedFigureBox[],
  pageIndex: number,
): StructuredQuestionT {
  const { prompt_text } = parseStemMarkItemTitle(node.MarkItemTitle ?? '');
  const subs = (node.MarkInfos ?? []).map((sub) =>
    nodeToLeaf(sub, pageMeta, figuresOut, pageIndex, 'sub'),
  );

  collectFigures(node.QuestionImagePositions, pageMeta, figuresOut, pageIndex);

  return {
    id: createId(),
    role: 'stem',
    prompt_text,
    page_index: pageIndex,
    sub_questions: subs,
    source: 'tencent_ocr',
  };
}

function nodeToLeaf(
  node: MarkInfoNode,
  pageMeta: PageMeta,
  figuresOut: ParsedFigureBox[],
  pageIndex: number,
  role: 'sub' | 'standalone',
): StructuredQuestionT {
  const { question_no, prompt_text, options } = parseSubMarkItemTitle(node.MarkItemTitle ?? '');

  // bbox
  let bbox: BBoxT | undefined;
  if (node.QuestionPositions && node.QuestionPositions.length === 8) {
    bbox = flat8ToBBox(node.QuestionPositions, pageMeta.pageWidth, pageMeta.pageHeight);
  }

  // AnswerInfos[0] 是主答案；多答案罕见
  const firstAnswer = node.AnswerInfos?.[0];
  const answers = firstAnswer?.RightAnswer ? [firstAnswer.RightAnswer] : undefined;
  const analysis = firstAnswer?.AnswerAnalysis;

  // extraction_evidence
  const evidence: StructuredQuestionT['extraction_evidence'] = {};
  if (firstAnswer?.HandwriteInfo) {
    const handwriting: { text: string; bbox: BBoxT }[] = [
      {
        text: firstAnswer.HandwriteInfo,
        bbox: firstAnswer.HandwriteInfoPositions
          ? flat8ToBBox(firstAnswer.HandwriteInfoPositions, pageMeta.pageWidth, pageMeta.pageHeight)
          : { x: 0, y: 0, width: 0, height: 0 },
      },
    ];
    evidence.handwriting = handwriting;
  }
  if (firstAnswer && (firstAnswer.IsCorrect !== undefined || firstAnswer.RightAnswer)) {
    evidence.tencent_grading = {
      IsCorrect: firstAnswer.IsCorrect ?? false,
      RightAnswer: firstAnswer.RightAnswer ?? '',
      AnswerAnalysis: firstAnswer.AnswerAnalysis,
      KnowledgePoints: firstAnswer.KnowledgePoints,
    };
  }

  collectFigures(node.QuestionImagePositions, pageMeta, figuresOut, pageIndex);

  return {
    id: createId(),
    role,
    question_no,
    prompt_text,
    options,
    answers,
    analysis,
    bbox,
    page_index: pageIndex,
    extraction_evidence: evidence.handwriting || evidence.tencent_grading ? evidence : undefined,
    source: 'tencent_ocr',
  };
}

function collectFigures(
  positions: QuestionImagePositionRaw[] | undefined,
  pageMeta: PageMeta,
  out: ParsedFigureBox[],
  pageIndex: number,
): void {
  if (!positions || positions.length === 0) return;
  for (const raw of positions) {
    const flat = Array.isArray(raw) ? raw : raw.Position;
    if (!flat) continue;
    if (flat.length !== 8) continue;
    out.push({
      bbox: flat8ToBBox(flat, pageMeta.pageWidth, pageMeta.pageHeight),
      source_page_index: pageIndex,
    });
  }
}
