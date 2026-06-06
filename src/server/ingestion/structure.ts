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
 * Mirrors the `runStepsJudge` (src/server/ai/judges/steps-judge.ts) pattern: an
 * auto-invoked multimodal task that passes `{ text, images }` through `runTask`,
 * parses strict JSON via a Zod schema, and accepts an injectable `runTaskFn` for
 * testability.
 *
 * YUK-227 S3 Slice A: Figure↔question matching is now performed by the VLM via
 * `figure_ids` on StructureNode. `preFigures` (sequence index + page_index) are
 * fed into the prompt so the VLM can self-report which figures belong to which
 * question. The result is surfaced as `figureAssignments` on StructureResult and
 * consumed by `assignFiguresFromVlm` in figure_attach.ts. The old Tencent-bbox
 * `assignFigures` heuristic is kept as a fallback (see figure_attach.ts).
 */
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';

import type { LayoutQuality } from './tencent_mark_parser';

// ---------- VLM output schema (id-less; ids assigned post-parse) ----------
//
// The VLM does NOT emit cuids — the prompt tells it to omit id, and we assign
// `createId()` after parse. This keeps the VLM output robust (no id namespace
// for the model to manage) and matches how rescue.ts synthesizes ids.

const QuestionOptionOut = z.object({
  label: z.string(),
  text: z.string(),
});

// Recursive node. z.lazy + explicit type (same shape technique as
// structured_question.ts StructuredQuestion).
type StructureNodeT = {
  role: 'stem' | 'sub' | 'standalone';
  question_no?: string | null;
  prompt_text: string;
  options?: { label: string; text: string }[] | null;
  answers?: string[] | null;
  analysis?: string | null;
  page_index?: number | null;
  sub_questions?: StructureNodeT[] | null;
  /**
   * YUK-227 S3 Slice A — VLM self-reported figure indices for this node.
   * Each entry is a 0-based index into the `preFigures` array passed to
   * runStructureTask. The VLM fills this when prompted; absence (null/empty)
   * means the VLM did not assign any figures to this node.
   */
  figure_ids?: number[] | null;
};

const StructureNode: z.ZodType<StructureNodeT> = z.lazy(() =>
  z.object({
    role: z.enum(['stem', 'sub', 'standalone']),
    question_no: z.string().nullable().optional(),
    prompt_text: z.string(),
    options: z.array(QuestionOptionOut).nullable().optional(),
    answers: z.array(z.string()).nullable().optional(),
    analysis: z.string().nullable().optional(),
    page_index: z.number().int().min(0).nullable().optional(),
    sub_questions: z.array(StructureNode).nullable().optional(),
    // YUK-227 S3 Slice A: figure indices reported by the VLM (see StructureNodeT).
    figure_ids: z.array(z.number().int().min(0)).nullable().optional(),
  }),
);

export const StructureOutput = z.object({
  layout_quality: z.enum(['structured', 'partial', 'text_only']),
  warnings: z.array(z.string()).default([]),
  questions: z.array(StructureNode),
});

export type StructureOutputT = z.infer<typeof StructureOutput>;

// ---------- Result shape (consumed by tencent_ocr_extract handler) ----------

/**
 * YUK-227 S3 Slice A — one VLM figure assignment: a pre-figure at `figure_index`
 * belongs to the question with `attached_to_question_id`.
 * `confidence` comes from the VLM's self-report context: 'high' when the VLM
 * explicitly assigned this figure via figure_ids, 'low' as fallback sentinel
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
export class StructureTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StructureTaskError';
  }
}

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
    prompt_text: node.prompt_text,
    source: 'vlm_structure',
  };
  if (node.question_no) out.question_no = node.question_no;
  if (node.options && node.options.length > 0) out.options = node.options;
  if (node.answers && node.answers.length > 0) out.answers = node.answers;
  if (node.analysis) out.analysis = node.analysis;
  if (subs && subs.length > 0) out.sub_questions = subs;
  // YUK-227 S3 Slice A (P1 fix): copy VLM page_index to the output so
  // q.page_index in the handler is non-null on the VLM path and
  // isAllPlaceholderPageIndex can distinguish VLM (real values) from
  // Tencent fallback (all page 0 via ??0 placeholder).
  if (node.page_index != null) out.page_index = node.page_index;

  // YUK-227 S3 Slice A: record figure_ids → question_id assignments while
  // traversing the tree so the caller can build figureAssignments.
  //
  // R2-2: duplicate figure_index detection. When the VLM assigns the same
  // figure_index to more than one node (e.g. both stem and sub claim the same
  // figure), the conflict is ambiguous — picking either assignment would be
  // wrong. We mark conflicting indices so assignFiguresFromVlm can discard
  // them and let the geometric heuristic decide instead (consistent with the
  // F1 conservative philosophy: uncertainty → geometric fallback).
  //
  // Implementation: push a sentinel assignment with attached_to_question_id=''
  // for any figure_index that already appears in assignmentsOut. The consumer
  // (assignFiguresFromVlm) discards any assignment whose figure_index appears
  // more than once regardless of content (it scans all assignments and collects
  // conflicts). The sentinel makes the duplicate visible without requiring a
  // two-pass approach here.
  if (assignmentsOut && node.figure_ids && node.figure_ids.length > 0) {
    const existingIndices = new Set(assignmentsOut.map((a) => a.figure_index));
    for (const figIdx of node.figure_ids) {
      if (existingIndices.has(figIdx)) {
        // Conflict: this figure_index was already claimed by another node.
        // Push a second entry so assignFiguresFromVlm sees the duplicate and
        // routes both to geometric fallback (R2-2).
        console.warn(
          `[nodeToStructured] figure_index=${figIdx} claimed by multiple VLM nodes; marking as conflict — geometric fallback will apply (R2-2)`,
        );
      }
      assignmentsOut.push({
        figure_index: figIdx,
        attached_to_question_id: id,
        confidence: 'high',
      });
      existingIndices.add(figIdx);
    }
  }

  return out;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new StructureTaskError('StructureTask output did not contain a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new StructureTaskError('StructureTask output was not valid JSON', { cause: err });
  }
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
   * index + page_index + position are passed (no bytes — the images are already
   * present in the page images array). position is a 3×3 grid label derived from
   * the figure's normalized bbox centre (F2: spatial anchor for same-page disambiguation).
   * Absent = no figures to assign.
   */
  preFigures?: Array<{ index: number; page_index: number; position: string }>;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: StructureRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile / r2). */
  ctx?: unknown;
};

async function defaultRunTaskFn(
  kind: string,
  input: { text: string; images: Array<{ data: string; mediaType: string }> },
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

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
    // figure↔question assignments via figure_ids on StructureNode. Only index +
    // page_index are passed; the actual image bytes are already in pageImages.
    ...(params.preFigures && params.preFigures.length > 0 ? { figures: params.preFigures } : {}),
  });

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
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
    parsed = StructureOutput.parse(extractJsonObject(llmText));
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
    warnings: parsed.warnings,
    ...(assignmentsOut && assignmentsOut.length > 0 ? { figureAssignments: assignmentsOut } : {}),
  };
}
