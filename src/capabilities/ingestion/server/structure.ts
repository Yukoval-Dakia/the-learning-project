/**
 * VLM StructureTask — T-OC slice 2 (YUK-145, OC-1/OC-2).
 *
 * See the design spec `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`
 * (OC-1/OC-2) + `docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md`.
 *
 * OC-1/OC-2: Tencent is demoted to a character-level **text OCR hint**; the VLM
 * (multimodal mimo-v2.5) owns the normalized structure. It sees all N page
 * images (in page order) + the Tencent text hint, and assembles a normalized
 * stem/sub/standalone tree — including 跨页大题 split across pages into ONE stem.
 *
 * Mirrors the Practice-owned `runStepsJudge` pattern: an
 * auto-invoked multimodal task that passes `{ text, images }` through `runTask`,
 * parses strict JSON via a Zod schema, and accepts an injectable `runTaskFn` for
 * testability.
 *
 * YUK-227 S3 Slice A: Figure↔question matching is now performed by the VLM via
 * `figure_ids` on StructureNode. `preFigures` (sequence index + page_index) are
 * fed into the prompt so the VLM can self-report which figures belong to which
 * question. The result is surfaced as `figureAssignments` on StructureResult and
 * consumed by `assignFiguresFromVlm` in figure_attach.ts. OCR fallback uses only
 * unambiguous same-page containment; uncertain crops stay unbound.
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
import type { LayoutQuality } from './tencent_mark_parser';

export { StructureOutput, type StructureOutputT, StructureTaskError };

// ---------- Result shape (consumed by tencent_ocr_extract handler) ----------

/**
 * YUK-227 S3 Slice A — one VLM figure assignment: a pre-figure at `figure_index`
 * belongs to the question with `attached_to_question_id`.
 * `confidence` comes from the VLM's self-report context: 'high' when the VLM
 * explicitly assigned this figure via figure_ids; 'low' denotes an uncertain claim
 * (not currently emitted here — the VLM always emits 'high' when it assigns).
 */
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
  /**
   * YUK-227 S3 Slice A — VLM figure assignments extracted from figure_ids on
   * StructureNode. Absent (undefined) when no preFigures were supplied or the
   * VLM did not assign any figures. Consumed by assignFiguresFromVlm().
   */
  figureAssignments?: FigureAssignment[];
};

/**
 * Thrown when the VLM structure step cannot produce a usable tree (provider
 * down, unparseable output, or zero questions). The handler catches this and
 * falls back to the Tencent structure (regression safety — lane plan §5).
 */
// ---------- Tencent text hint rendering ----------

export type TencentPageHint = {
  page_index: number;
  questions: StructuredQuestionT[];
};

/**
 * Render the demoted Tencent structure as a flat text hint for the VLM. Each
 * page is prefixed with `=== page K ===`; per top-level question we reuse
 * `structuredToPromptMarkdown` (the canonical structured→markdown derivation).
 * This is advisory text only — the VLM owns the structure of record.
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

// ---------- YUK-1404: explicit math delimiter canonicalization ----------
//
// Settled producer decision (YUK-1404): extracted stems STORE explicit
// `$inline$` / `$$display$$` math. The StructureTask prompt now instructs the
// VLM to emit dollar delimiters, but the Tencent text hint (and model habit)
// can carry the equally-explicit LaTeX forms \(...\) / \[...\]. Those — and
// ONLY those already-explicitly-delimited spans — are canonicalized to the
// dollar form here, at the canonical mapping. No undelimited text is ever
// wrapped (no guessing around bare backslashes or prose).
//
// Mirrors the proven renderer gate (src/ui/lib/math-markdown.tsx
// LATEX_DELIMITED): code spans/fences are matched first and returned
// untouched; a delimiter preceded by another backslash is a LaTeX line break,
// not an opener; a formula never crosses a blank line or a backtick. The
// spacing guards keep neighbouring `$...$` / `$$...$$` runs apart after
// conversion (`$a$$b$` would parse as one broken formula downstream).
const EXPLICIT_MATH_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

/** Canonicalize already-explicit \(...\) / \[...\] math to $...$ / $$...$$. */
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
 * YUK-227 S3 Slice A — walk the VLM node tree, assign cuid ids, and collect
 * figure_ids → question_id assignments into `assignmentsOut`. The collector is
 * mutated in place so callers don't need to thread a return value through the
 * recursive walk.
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
  // YUK-227 S3 Slice A (P1 fix): copy VLM page_index to the output so
  // q.page_index in the handler is non-null on the VLM path and
  // isAllPlaceholderPageIndex can distinguish VLM (real values) from
  // Tencent fallback (all page 0 via ??0 placeholder).
  if (node.page_index != null) out.page_index = node.page_index;

  // Preserve explicit clean-pixel evidence for prospective public figures.
  // Omitted/null remains unknown; true remains private student-work evidence.
  if (node.student_answer_present != null) out.student_answer_present = node.student_answer_present;

  // Keep every figure_ids claim with its generated structured id. The attachment
  // consumer withholds conflicting claims instead of inventing another owner.
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
   * YUK-227 S3 Slice A — minimal per-figure info fed to the VLM so it can
   * self-report figure↔question assignments via figure_ids on StructureNode.
   * Index, page_index, position and bbox identify the crop (image bytes are already
   * present in the page images array). The bbox distinguishes crops within the
   * same 3×3 position label.
   * Absent = no figures to assign.
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
 * Runs the VLM StructureTask. Returns a normalized question tree (ids assigned)
 * shaped for `Ingestion.applyExtractionResult`. Throws `StructureTaskError` on
 * provider failure / unparseable output / zero questions so the handler can fall
 * back to the Tencent structure.
 */
export async function runStructureTask(params: RunStructureTaskParams): Promise<StructureResult> {
  if (params.pageImages.length === 0) {
    throw new StructureTaskError('runStructureTask: no page images provided');
  }

  const textPayload = JSON.stringify({
    tencent_hint_md: params.tencentHintMd,
    page_count: params.pageCount,
    // YUK-227 S3 Slice A: pass minimal figure metadata so the VLM can self-report
    // figure↔question assignments via figure_ids on StructureNode. Coordinates
    // identify the exact crop; the image bytes are already in pageImages.
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

  // YUK-227 S3 Slice A: collect figure assignments while mapping nodes.
  // Only populate the collector when preFigures were supplied (no-op otherwise).
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
