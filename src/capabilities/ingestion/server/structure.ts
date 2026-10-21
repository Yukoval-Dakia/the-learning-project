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
};

export type StructureResult = {
  questions: StructuredQuestionT[];
  layout_quality: LayoutQuality;
  /** Overall confidence in the extracted structure; persisted on each emitted block. */
  extraction_confidence?: number;
  warnings: string[];
  /** Absent when no preFigures were supplied or none were assigned. */
  figureAssignments?: FigureAssignment[];
};

/**
 * Thrown when the VLM cannot produce a usable tree; the handler catches it and falls
 * back to OCR structure.
 */
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
  const out: StructuredQuestionT = {
    id,
    role: node.role,
    prompt_text: canonicalizeExplicitMathDelimiters(node.prompt_text),
    source: 'vlm_structure',
  };
  if (node.question_no) out.question_no = node.question_no;
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

  return out;
}

// ---------- runStructureTask ----------

export type StructureRunTaskFn = (
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> },
  ctx: unknown,
) => Promise<{ text: string }>;

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
  try {
    const result = await runTaskFn(
      'StructureTask',
      { text: textPayload, images: params.pageImages },
      params.ctx ?? {},
    );
    llmText = result.text;
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
    ...(assignmentsOut && assignmentsOut.length > 0 ? { figureAssignments: assignmentsOut } : {}),
  };
}
