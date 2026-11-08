/**
 * VLM StructureTask.
 *
 * OCR is only a character-level text hint; the VLM sees all page images plus that
 * hint and owns the normalized tree, including cross-page stems. It parses strict
 * JSON through a Zod schema and accepts an injectable runner for tests.
 *
 * The VLM also reports figure↔question ownership via figure_ids, surfaced as
 * figureAssignments. The OCR fallback binds only unambiguous containment; uncertain
 * crops stay unbound.
 */

import { createId } from '@paralleldrive/cuid2';
import {
  type StructureNodeT,
  StructureOutput,
  type StructureOutputT,
  StructureTaskError,
  parseStructureOutput,
} from '@/capabilities/ingestion/tasks/structure';
import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import {
  matchPromptHeadQuestionNo,
  parseQuestionNo,
} from '@/kernel/proposals/block-merge-admission';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { redactIngestionText } from './privacy-guard';
import type { LayoutQuality } from './tencent_mark_parser';

export { StructureOutput, type StructureOutputT, StructureTaskError };

// ---------- Result shape (consumed by tencent_ocr_extract handler) ----------

/** One VLM figure assignment: pre-figure `figure_index` belongs to a question. */
export type FigureAssignment = {
  figure_index: number;
  attached_to_question_id: string;
  confidence: 'high' | 'low';
  option_label?: string;
};

export type StructureResult = {
  questions: StructuredQuestionT[];
  layout_quality: LayoutQuality;
  /** Overall confidence in the extracted structure; persisted on each emitted block. */
  extraction_confidence?: number;
  warnings: string[];
  content_lost?: boolean | null;
  figureHandwriting?: StructureOutputT['figure_handwriting'];
  /** Absent when no preFigures were supplied or none were assigned. */
  figureAssignments?: FigureAssignment[];
  /** Durable run id of the StructureTask call — binds its cost to the session. */
  task_run_id?: string;
};

// ---------- Tencent text hint rendering ----------

export type TencentPageHint = {
  page_index: number;
  questions: StructuredQuestionT[];
};

/**
 * Renders OCR structure as an advisory text hint. The VLM owns the structure of
 * record; per top-level question this reuses the canonical markdown derivation.
 */
export function renderTencentHint(pages: TencentPageHint[]): string {
  const parts: string[] = [];
  for (const page of pages) {
    parts.push(`=== page ${page.page_index} ===`);
    if (page.questions.length === 0) {
      parts.push('(腾讯未识别出题目)');
      continue;
    }
    for (const q of page.questions) {
      parts.push(structuredToPromptMarkdown(q));
    }
  }
  return parts.join('\n\n');
}

// ---------- Mapping VLM nodes → StructuredQuestionT ----------

// Stems store explicit dollar-delimited math. Only spans already delimited as
// \(...\) / \[...\] are canonicalized; undelimited prose is never wrapped. The
// guards mirror the renderer: code spans/fences stay untouched, a double backslash
// is a line break, formulas never cross blank lines/backticks, and spacing keeps
// adjacent formulas from merging.
const EXPLICIT_MATH_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

/** Canonicalizes already-delimited LaTeX math to dollar delimiters. */
function canonicalizeExplicitMathDelimiters(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  return text.replace(
    EXPLICIT_MATH_DELIMITED,
    (
      match: string,
      code: string | undefined,
      display: string | undefined,
      inline: string | undefined,
      offset: number,
    ) => {
      if (code !== undefined) return match;
      const prev = text.slice(Math.max(0, offset - 2), offset);
      const before = prev.endsWith('$') || prev === '\\)' || prev === '\\]' ? ' ' : '';
      const after = text[offset + match.length] === '$' ? ' ' : '';
      if (display !== undefined) return `${before}$$${display}$$${after}`;
      return `${before}$${(inline ?? '').trim()}$${after}`;
    },
  );
}

// Deterministic repair for the two observed contamination modes: the model left
// the printed number or a standalone section header line inside prompt_text.
// Moving them into their own fields preserves the printed numbering and keeps
// section text out of the stem. Only a strictly-shaped leading token moves —
// anything ambiguous stays in prompt_text, and a head number conflicting with
// the node's own question_no stays (it may be genuine content). The head shape
// itself is matchPromptHeadQuestionNo's — the same parser merge admission uses
// — so a decimal like `0.75` or an inline 「（1）（2）」 enumeration never
// moves.

// A leading line that is nothing but a Chinese-ordinal section header, e.g.
// 「一、选择题」. Requires the line to end (newline or string end) right after
// a section-y word so prose beginning 「一、…」 does not qualify.
const SECTION_HEAD_LINE_RE =
  /^\s*([一二三四五六七八九十]+、[^\n]{1,15}(?:题|卷|部分|篇|章|节|板块))[ \t]*(?:\n|$)/u;

/**
 * Walks the VLM tree, assigns ids, and collects figure assignments into
 * `assignmentsOut` so the recursive walk needs no return value.
 */
function nodeToStructured(
  node: StructureNodeT,
  assignmentsOut?: FigureAssignment[],
): StructuredQuestionT {
  const id = createId();
  const isStem = node.role === 'stem';
  const subs =
    isStem && node.sub_questions
      ? node.sub_questions.map((s) => nodeToStructured(s, assignmentsOut))
      : undefined;
  let promptText = canonicalizeExplicitMathDelimiters(node.prompt_text);
  let section = node.section?.trim() || undefined;
  let questionNo = node.question_no?.trim() || undefined;

  const sectionMatch = SECTION_HEAD_LINE_RE.exec(promptText);
  if (sectionMatch && promptText.slice(sectionMatch[0].length).trim().length > 0) {
    section = section ?? sectionMatch[1].trim();
    promptText = promptText.slice(sectionMatch[0].length);
  }

  const numberMatch = matchPromptHeadQuestionNo(promptText);
  if (numberMatch && numberMatch.parsed.kind !== 'unknown') {
    const headNo = numberMatch.parsed.value;
    const rest = promptText.slice(numberMatch.matchLength).replace(/^[ \t]+/, '');
    const own = questionNo === undefined ? null : parseQuestionNo(questionNo);
    const sameNumber = own !== null && own.kind !== 'unknown' && own.value === headNo;
    if (rest.trim().length > 0 && (own === null || sameNumber)) {
      questionNo = questionNo ?? String(headNo);
      promptText = rest;
    }
  }

  const out: StructuredQuestionT = {
    id,
    role: node.role,
    prompt_text: promptText,
    source: 'vlm_structure',
  };
  if (questionNo) out.question_no = questionNo;
  if (section) out.section = section;
  if (node.kind) out.kind = node.kind;
  if (node.options && node.options.length > 0)
    out.options = node.options.map((option) => ({
      label: option.label,
      text: canonicalizeExplicitMathDelimiters(option.text),
    }));
  if (node.answers && node.answers.length > 0) out.answers = node.answers;
  if (node.analysis) out.analysis = node.analysis;
  if (subs && subs.length > 0) out.sub_questions = subs;
  // Copy page_index so the handler can distinguish VLM pages from the Tencent
  // fallback's placeholder 0.
  if (node.page_index != null) out.page_index = node.page_index;

  // Omitted stays unknown; true means private student-work evidence.
  if (node.student_answer_present != null) out.student_answer_present = node.student_answer_present;

  // Keep each claim with its generated id; conflicting claims are withheld later.
  if (assignmentsOut && node.figure_ids && node.figure_ids.length > 0) {
    for (const figIdx of node.figure_ids) {
      assignmentsOut.push({
        figure_index: figIdx,
        attached_to_question_id: id,
        confidence: 'high',
      });
    }
  }

  for (const option of node.options ?? []) {
    for (const figure_index of option.figure_ids ?? []) {
      assignmentsOut?.push({
        figure_index,
        attached_to_question_id: id,
        confidence: 'high',
        option_label: option.label,
      });
    }
  }
  return out;
}

// ---------- runStructureTask ----------

export type StructureRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> },
  ctx: unknown,
) => Promise<{ text: string; task_run_id?: string }>;

export type RunStructureTaskParams = {
  /** Page images in page order (page 0 first). base64 data, no data: prefix. */
  pageImages: Array<{ data: string; mediaType: string }>;
  /** The demoted Tencent text hint (see renderTencentHint). */
  tencentHintMd: string;
  /** Number of pages (so the VLM knows the page count). */
  pageCount: number;
  /**
   * Minimal figure metadata for VLM self-assignment. The bbox distinguishes crops
   * sharing a 3×3 position label; image bytes are already in the page images.
   */
  preFigures?: Array<{
    index: number;
    page_index: number;
    position: string;
    bbox?: StructuredQuestionT['bbox'];
  }>;
  /** Database bound by the production runner; tests may inject runTaskFn instead. */
  db?: Db;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: StructureRunTaskFn;
  /** Forwarded to runTask ctx (subjectProfile / r2 only). */
  ctx?: unknown;
};

/**
 * Returns an id-assigned tree for applyExtractionResult. Throws StructureTaskError
 * so the handler can fall back to OCR structure.
 */
export async function runStructureTask(params: RunStructureTaskParams): Promise<StructureResult> {
  if (params.pageImages.length === 0) {
    throw new StructureTaskError('runStructureTask: no page images provided');
  }

  const textPayload = JSON.stringify({
    // Redact the text hint; page images stay raw because they are the input itself.
    tencent_hint_md: redactIngestionText(params.tencentHintMd).text,
    page_count: params.pageCount,
    // Coordinates identify the exact crop for figure_ids self-assignment.
    ...(params.preFigures && params.preFigures.length > 0 ? { figures: params.preFigures } : {}),
  });

  if (params.runTaskFn === undefined && params.db === undefined) {
    throw new StructureTaskError('runStructureTask requires db when using the default runner');
  }
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db as Db);
  let llmText: string;
  let taskRunId: string | undefined;
  try {
    const result = await runTaskFn(
      'StructureTask',
      { text: textPayload, images: params.pageImages },
      params.ctx ?? {},
    );
    llmText = result.text;
    taskRunId = result.task_run_id;
  } catch (err) {
    throw new StructureTaskError('StructureTask LLM call failed', { cause: err });
  }

  let parsed: StructureOutputT;
  try {
    parsed = parseStructureOutput(llmText);
  } catch (err) {
    if (err instanceof StructureTaskError) throw err;
    throw new StructureTaskError('StructureTask output did not match StructureOutput schema', {
      cause: err,
    });
  }

  if (parsed.questions.length === 0) {
    throw new StructureTaskError('StructureTask returned 0 questions');
  }

  // Collect assignments while mapping; no-op without preFigures.
  const assignmentsOut: FigureAssignment[] | undefined =
    params.preFigures && params.preFigures.length > 0 ? [] : undefined;
  const questions = parsed.questions.map((node) => nodeToStructured(node, assignmentsOut));
  return {
    questions,
    layout_quality: parsed.layout_quality,
    extraction_confidence: parsed.extraction_confidence,
    warnings: parsed.warnings,
    content_lost: parsed.content_lost ?? null,
    figureHandwriting: parsed.figure_handwriting,
    ...(assignmentsOut && assignmentsOut.length > 0 ? { figureAssignments: assignmentsOut } : {}),
    ...(taskRunId !== undefined ? { task_run_id: taskRunId } : {}),
  };
}
