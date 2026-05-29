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
 * Figure↔question matching (replacing `assignFigures`) is DEFERRED to slice 2b
 * (see lane plan §DEFERRED) — this module does NOT attach figures; the handler
 * keeps the Tencent-bbox `assignFigures` heuristic for now.
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
  }),
);

export const StructureOutput = z.object({
  layout_quality: z.enum(['structured', 'partial', 'text_only']),
  warnings: z.array(z.string()).default([]),
  questions: z.array(StructureNode),
});

export type StructureOutputT = z.infer<typeof StructureOutput>;

// ---------- Result shape (consumed by tencent_ocr_extract handler) ----------

export type StructureResult = {
  questions: StructuredQuestionT[];
  layout_quality: LayoutQuality;
  warnings: string[];
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

function nodeToStructured(node: StructureNodeT): StructuredQuestionT {
  const isStem = node.role === 'stem';
  const subs = isStem && node.sub_questions ? node.sub_questions.map(nodeToStructured) : undefined;
  const out: StructuredQuestionT = {
    id: createId(),
    role: node.role,
    prompt_text: node.prompt_text,
    source: 'vlm_structure',
  };
  if (node.question_no) out.question_no = node.question_no;
  if (node.options && node.options.length > 0) out.options = node.options;
  if (node.answers && node.answers.length > 0) out.answers = node.answers;
  if (node.analysis) out.analysis = node.analysis;
  if (subs && subs.length > 0) out.sub_questions = subs;
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

  const questions = parsed.questions.map(nodeToStructured);
  return {
    questions,
    layout_quality: parsed.layout_quality,
    warnings: parsed.warnings,
  };
}
