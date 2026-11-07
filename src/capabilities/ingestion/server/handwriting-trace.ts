import type { TaskTextResult } from '@/ai/task-result';
import {
  type HandwritingTraceInputT,
  type HandwritingTraceLeafT,
  type HandwritingTraceOutputT,
  HandwritingTraceTaskError,
  parseHandwritingTraceOutput,
} from '@/capabilities/ingestion/tasks/handwriting';
import { MAX_PDF_PAGES } from '@/core/limits';
import type { BBoxT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { markAiTaskRunOutputInvalid } from '@/server/ai/log';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { redactIngestionText } from './privacy-guard';

// Per-question handwriting evidence from a photographed page. The task reads the
// learner's own writing and red-pen marks; nothing here decides right/wrong, and
// the result is written to `extraction_evidence.handwriting` only — never to a
// question's answer/reference fields. A trace that cannot be assigned to exactly
// one leaf is dropped (no cross-question assignment).

export type HandwritingTraceModelInput = {
  text: string;
  images: Array<{ data: string | Uint8Array; mediaType: string }>;
};

export type HandwritingTraceRunTaskFn = (
  kind: string,
  input: HandwritingTraceModelInput,
  ctx: unknown,
) => Promise<TaskTextResult>;

export interface RunHandwritingTraceParams {
  /** Page images in page order (page 0 first), base64 data without the data: prefix. */
  pageImages: Array<{ data: string; mediaType: string }>;
  pageCount: number;
  /** Leaves in reading order; `index` is the identity used by the task output. */
  leaves: HandwritingTraceLeafT[];
  /** Database bound by the production runner; tests may inject runTaskFn instead. */
  db?: Db;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: HandwritingTraceRunTaskFn;
  /** Forwarded to runTask ctx (subjectProfile / r2). */
  ctx?: unknown;
}

export interface HandwritingTraceResult extends HandwritingTraceOutputT {
  task_run_id?: string;
  cost_usd?: number;
  warnings: string[];
}

/** Leaves in reading order. A stem/container is not a leaf; only its sub-questions are. */
export function collectHandwritingLeaves(
  questions: readonly StructuredQuestionT[],
): Array<{ index: number; node: StructuredQuestionT }> {
  const leaves: Array<{ index: number; node: StructuredQuestionT }> = [];
  const walk = (node: StructuredQuestionT) => {
    const subs = node.sub_questions ?? [];
    if (subs.length > 0) {
      for (const sub of subs) walk(sub);
      return;
    }
    leaves.push({ index: leaves.length, node });
  };
  for (const question of questions) walk(question);
  return leaves;
}

/** A page-local box from the trace task; `page_index` is its page identity. */
type TraceBBoxT = BBoxT & { page_index: number };

function clampBBox(bbox: BBoxT): BBoxT {
  const x = Math.min(Math.max(bbox.x, 0), 1);
  const y = Math.min(Math.max(bbox.y, 0), 1);
  return {
    x,
    y,
    width: Math.min(Math.max(bbox.width, 0), 1 - x),
    height: Math.min(Math.max(bbox.height, 0), 1 - y),
  };
}

/** A box that cannot name a real page-local region is omitted, never faked as zero. */
function isUsableBBox(
  bbox: TraceBBoxT | null | undefined,
  nodePageIndex: number | undefined,
): bbox is TraceBBoxT {
  if (bbox == null) return false;
  if (bbox.page_index !== (nodePageIndex ?? bbox.page_index)) return false;
  if (![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) return false;
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.width > 0 &&
    bbox.height > 0 &&
    bbox.x + bbox.width <= 1 &&
    bbox.y + bbox.height <= 1
  );
}

/**
 * Writes validated traces onto their leaves as `extraction_evidence.handwriting`.
 * Existing evidence is left untouched. Returns the number of leaves that gained a
 * trace. Never throws for out-of-range / duplicate indexes; those are reported in
 * `warnings` so the caller can keep the extraction honest.
 */
export function applyHandwritingTraces(
  questions: readonly StructuredQuestionT[],
  output: Pick<HandwritingTraceOutputT, 'traces' | 'unresolved'>,
): { applied: number; warnings: string[] } {
  const warnings: string[] = [];
  const leaves = collectHandwritingLeaves(questions);
  const byIndex = new Map(leaves.map((leaf) => [leaf.index, leaf.node]));
  const seen = new Set<number>();
  let applied = 0;
  // A successful pass (even with zero traces) is evidence that the pass ran;
  // the capture path must not confuse it with a failed/absent pass.
  for (const root of questions) {
    root.extraction_evidence = {
      ...(root.extraction_evidence ?? {}),
      handwriting_trace: { status: 'completed' },
    };
  }
  for (const trace of output.traces) {
    const node = byIndex.get(trace.leaf_index);
    if (!node) {
      warnings.push(`handwriting trace ignored: leaf_index ${trace.leaf_index} out of range`);
      continue;
    }
    if (seen.has(trace.leaf_index)) {
      warnings.push(`handwriting trace ignored: duplicate leaf_index ${trace.leaf_index}`);
      continue;
    }
    seen.add(trace.leaf_index);
    const text = trace.text.trim();
    const redInk =
      trace.red_mark === 'none' || trace.red_mark === 'unknown' ? null : trace.red_mark;
    if (text.length === 0 && redInk === null && !trace.red_text) continue;
    const existing = node.extraction_evidence?.handwriting ?? [];
    if (existing.length > 0) continue;
    const bbox = isUsableBBox(trace.bbox, node.page_index) ? clampBBox(trace.bbox) : undefined;
    node.extraction_evidence = {
      ...(node.extraction_evidence ?? {}),
      handwriting: [
        {
          text,
          ...(bbox !== undefined ? { bbox } : {}),
          ...(redInk !== null ? { red_ink: redInk } : {}),
          ...(trace.red_text ? { red_text: true } : {}),
          ...(trace.confidence > 0 ? { confidence: trace.confidence } : {}),
        },
      ],
    };
    node.student_answer_present = true;
    applied += 1;
  }
  for (const item of output.unresolved) {
    // An unresolved item that names a leaf still proves student work in that area;
    // mark it present without text so capture records an explicit unknown instead
    // of silently treating the question as unanswered. A null leaf stays page-level
    // and is only a warning (never assigned to a question by proximity).
    if (item.leaf_index !== undefined && item.leaf_index !== null) {
      const node = byIndex.get(item.leaf_index);
      if (node) node.student_answer_present = true;
    }
    warnings.push(
      `handwriting trace unresolved for leaf_index ${item.leaf_index ?? 'unknown'}: ${item.reason}`,
    );
  }
  return { applied, warnings };
}

/**
 * Records that the whole-pass trace produced no usable evidence. The marker is
 * what lets capture record `unknown` instead of silently treating the page as
 * "no handwriting", and what the page/slice 5 can read to retry.
 */
export function markHandwritingTraceFailure(
  questions: readonly StructuredQuestionT[],
  reason: string,
): void {
  for (const root of questions) {
    root.extraction_evidence = {
      ...(root.extraction_evidence ?? {}),
      handwriting_trace: { status: 'failed', reason: reason.slice(0, 300) },
    };
  }
}

/**
 * Runs HandwritingTraceTask over the supplied page images and leaves. Throws
 * `HandwritingTraceTaskError` on provider failure or unparseable output; the
 * extraction caller treats that as a warning, never as a failed page.
 */
export async function runHandwritingTrace(
  params: RunHandwritingTraceParams,
): Promise<HandwritingTraceResult> {
  if (params.pageImages.length === 0) {
    throw new HandwritingTraceTaskError('runHandwritingTrace: no page images provided');
  }
  if (params.pageImages.length > MAX_PDF_PAGES) {
    // One call carries every page image and every leaf; uploads are already capped at
    // MAX_PDF_PAGES, so this only catches a caller bypassing that gate.
    throw new HandwritingTraceTaskError(
      `runHandwritingTrace: ${params.pageImages.length} pages exceeds the ${MAX_PDF_PAGES}-page single-call cap`,
    );
  }
  if (params.leaves.length === 0) {
    throw new HandwritingTraceTaskError('runHandwritingTrace: no leaves provided');
  }
  if (params.runTaskFn === undefined && params.db === undefined) {
    throw new HandwritingTraceTaskError(
      'runHandwritingTrace requires db when using the default runner',
    );
  }
  const input: HandwritingTraceInputT = {
    page_count: params.pageCount,
    leaves: params.leaves.map((leaf) => ({
      index: leaf.index,
      page_index: leaf.page_index,
      question_no: leaf.question_no ?? null,
      // Redact before the model sees the prompt; handwriting execution still reads pixels.
      prompt_text: redactIngestionText(leaf.prompt_text).text,
    })),
  };
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db as Db);
  let result: TaskTextResult;
  try {
    // Multimodal envelope: the runner only attaches image blocks when it sees
    // `{text, images}`. Passing the bare JSON input here silently dropped every
    // page image, letting the model invent traces from prompt text alone.
    result = await runTaskFn(
      'HandwritingTraceTask',
      { text: JSON.stringify(input), images: params.pageImages },
      params.ctx ?? {},
    );
  } catch (err) {
    throw new HandwritingTraceTaskError('HandwritingTraceTask LLM call failed', { cause: err });
  }
  let parsed: HandwritingTraceOutputT;
  try {
    parsed = parseHandwritingTraceOutput(result.text);
  } catch (err) {
    if (err instanceof HandwritingTraceTaskError) throw err;
    const reason =
      err instanceof Error ? err.message : 'HandwritingTraceTask output did not match schema';
    if (params.db !== undefined && result.task_run_id !== undefined) {
      // The provider call succeeded but its text was not usable: not a success run.
      try {
        await markAiTaskRunOutputInvalid(params.db, result.task_run_id, reason);
      } catch (markErr) {
        console.error('[handwriting_trace] failed to mark invalid model output', markErr);
      }
    }
    throw new HandwritingTraceTaskError(
      'HandwritingTraceTask output did not match HandwritingTraceOutput schema',
      { cause: err },
    );
  }
  const warnings: string[] = [];
  for (const trace of parsed.traces) {
    if (trace.leaf_index >= params.leaves.length) {
      warnings.push(`handwriting trace ignored: leaf_index ${trace.leaf_index} out of range`);
    }
  }
  return {
    ...parsed,
    ...(result.task_run_id !== undefined ? { task_run_id: result.task_run_id } : {}),
    ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
    warnings,
  };
}
