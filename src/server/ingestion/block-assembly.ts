/**
 * BlockAssemblyTask — YUK-202 / BlockAssembly path-B (design note
 * `docs/superpowers/specs/2026-06-02-blockassembly-pathb-design.md` §2 + §3).
 *
 * AI ONLY proposes cross-page / adjacent block merges; the user accepts in the
 * proposal inbox; acceptance reuses the YUK-195 `mergeQuestions` primitive (S2).
 * This module is the producer side: it looks at all draft blocks of one ingestion
 * session, asks the model which adjacent blocks are ONE logical question split
 * apart, and writes a `block_merge` proposal per candidate via
 * `writeBlockMergeProposal`. NO auto-merge — that is the hard safety boundary
 * (§5); `mergeQuestions` runs only on user accept.
 *
 * YUK-227 S3 Slice A (F4 owner decision — "本章立即消费"):
 * path-B is upgraded from SEMANTIC-ONLY to consume spatial signals when available.
 * `projectBlock` now includes `page_index` from `page_spans[0]` so the model can
 * use page continuity as a signal. Safe degradation rule: when ALL blocks in the
 * session have placeholder page_index=0 (Tencent fallback path), `page_index` is
 * omitted from the projected input — the model reverts to pure semantic reasoning,
 * producing zero regression on that path. Only sessions where VLM-path page_spans
 * carry real page_index values get the spatial upgrade.
 *
 * Adjacency = the natural session block array order (INSERT order); there is no
 * ordering column. bbox pixel-level detection remains deferred (ADR-0002: VLM
 * does not give pixel bbox). The task input gains a `page_index` field — no
 * rework needed on the output schema or proposal writer side.
 *
 * Mirrors `runStructureTask` (src/server/ingestion/structure.ts): an in-module
 * output schema, an injectable `runTaskFn` for testability, an extractJsonObject
 * helper, and a typed error. Model = the lightweight TaggingTask tier (input is
 * structured TEXT, not page images — NOT vision/multimodal).
 */
import { z } from 'zod';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { writeBlockMergeProposal } from '@/server/proposals/producers';

// ---------- BlockAssemblyOutput schema (the model's structured output) ----------
//
// Each candidate names one `primary_block_id` (keeps its structured tree) + the
// `merge_block_ids` that fold into it (min 1), a 0..1 `confidence`, the
// `continuity_signal` (semantic-only enum, §0), and a `reason_md` explaining the
// continuity cue. `signal` mirrors the proposal's `continuity_signal` enum so the
// candidate maps 1:1 onto `writeBlockMergeProposal`.

export const BlockAssemblyCandidate = z.object({
  primary_block_id: z.string().min(1),
  merge_block_ids: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  signal: z.enum(['page_edge', 'numbering', 'stem_answer_split', 'carryover']),
  reason_md: z.string(),
});
export type BlockAssemblyCandidateT = z.infer<typeof BlockAssemblyCandidate>;

export const BlockAssemblyOutput = z.object({
  candidates: z.array(BlockAssemblyCandidate).default([]),
});
export type BlockAssemblyOutputT = z.infer<typeof BlockAssemblyOutput>;

/**
 * Thrown when the BlockAssemblyTask cannot produce a usable result (provider
 * down, unparseable output). The session pass (`runBlockAssemblyForSession`) and
 * its auto_enroll caller SWALLOW this — merge proposals are nice-to-have, never
 * the critical path; an outage must not abort enrollment (§3).
 */
export class BlockAssemblyTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlockAssemblyTaskError';
  }
}

// ---------- runBlockAssemblyTask — the AI task wrapper ----------

export type BlockAssemblyRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

/** One block projected to the compact text view the model reasons over. */
export interface BlockAssemblyInputBlock {
  block_id: string;
  question_no: string | null;
  /** Head of the prompt text (truncated) — enough to judge continuity. */
  prompt_head: string;
  role: StructuredQuestionT['role'] | null;
  sub_question_count: number;
  layout_quality: string | null;
  /**
   * YUK-227 S3 Slice A (F4): page_index from page_spans[0]. Present only when
   * the session has at least one block with a real (non-placeholder) page_index
   * (i.e. VLM-path sessions). Absent on all-placeholder sessions so the model
   * falls back to pure semantic reasoning (zero regression — Tencent path).
   */
  page_index?: number;
}

export interface BlockAssemblyInput {
  ingestion_session_id: string;
  /** Draft blocks in session array order (INSERT order = adjacency, §0). */
  blocks: BlockAssemblyInputBlock[];
}

export interface RunBlockAssemblyTaskParams {
  input: BlockAssemblyInput;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: BlockAssemblyRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new BlockAssemblyTaskError('BlockAssemblyTask output did not contain a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new BlockAssemblyTaskError('BlockAssemblyTask output was not valid JSON', { cause: err });
  }
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

/**
 * Runs the BlockAssemblyTask. Returns a validated `BlockAssemblyOutput`. Throws
 * `BlockAssemblyTaskError` on provider failure / unparseable output so the
 * session pass can swallow it (proposals are best-effort, §3).
 */
export async function runBlockAssemblyTask(
  params: RunBlockAssemblyTaskParams,
): Promise<BlockAssemblyOutputT> {
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let llmText: string;
  try {
    const result = await runTaskFn('BlockAssemblyTask', params.input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new BlockAssemblyTaskError('BlockAssemblyTask LLM call failed', { cause: err });
  }

  let parsed: BlockAssemblyOutputT;
  try {
    parsed = BlockAssemblyOutput.parse(extractJsonObject(llmText));
  } catch (err) {
    if (err instanceof BlockAssemblyTaskError) throw err;
    throw new BlockAssemblyTaskError(
      'BlockAssemblyTask output did not match BlockAssemblyOutput schema',
      { cause: err },
    );
  }
  return parsed;
}

// ---------- runBlockAssemblyForSession — the session-level pass ----------

/** A draft block as loaded by the auto_enroll pass (subset we need to project). */
export interface BlockAssemblySourceBlock {
  id: string;
  structured: StructuredQuestionT | null;
  layout_quality: string | null;
  /**
   * YUK-227 S3 Slice A (F4): page_spans as stored by the extraction handler.
   * The first span's page_index is used for spatial matching when real values
   * are available (VLM path). Placeholder page_index=0 (Tencent fallback) is
   * detected at the session level and causes spatial projection to be skipped
   * — zero regression on the Tencent fallback path.
   */
  page_spans?: Array<{
    page_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    role?: string;
  }>;
}

export interface RunBlockAssemblyForSessionParams {
  sessionId: string;
  /** Draft blocks of the session in array order (adjacency, §0). */
  blocks: BlockAssemblySourceBlock[];
  /** Inject in tests; defaults to the production BlockAssemblyTask invoker. */
  runTaskFn?: BlockAssemblyRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

export interface RunBlockAssemblyForSessionResult {
  /** Number of `block_merge` proposals written (one per accepted candidate). */
  proposed: number;
  /** Proposal event ids (evidence / logging). */
  proposal_ids: string[];
}

// Max chars of prompt text projected per block — enough to judge continuity for
// v1's semantic-only signals. A fixed head can miss late "承接前题" cues in very
// long stems; when spatial signals are available (VLM path), the model also gets
// page_index which may resolve ambiguous cross-page splits more reliably. Tune
// PROMPT_HEAD_CHARS here, not inline.
const PROMPT_HEAD_CHARS = 400;

/**
 * YUK-227 S3 Slice A (F4): returns true when ALL blocks in the session carry
 * placeholder page_index=0 (i.e. the Tencent fallback path or sessions from
 * before slice A). When true, page_index is omitted from the projected input
 * so the model falls back to pure semantic reasoning — zero regression.
 *
 * A session is "all-placeholder" when every block's first page_span has
 * page_index === 0 (or page_spans is absent/empty). A single block with a
 * non-zero page_index is sufficient to enable spatial projection for the
 * whole session (the VLM path assigns real page indices starting from 0, so
 * page_index=0 is valid but ambiguous; we only skip when EVERY block is 0).
 *
 * Exported for unit testing; callers outside this module should not rely on it.
 */
export function isAllPlaceholderPageIndex(blocks: BlockAssemblySourceBlock[]): boolean {
  return blocks.every((b) => {
    const firstSpan = b.page_spans?.[0];
    return !firstSpan || firstSpan.page_index === 0;
  });
}

/**
 * Project one draft block's structured tree to the compact text view the model
 * reasons over (§2 input projection).
 *
 * YUK-227 S3 Slice A (F4): when `includeSpatial` is true (VLM path with real
 * page_index values), page_index from the first page_span is included so the
 * model can use page continuity as a signal. When false (Tencent fallback /
 * all-placeholder), page_index is omitted → pure semantic reasoning (no change
 * from before, zero regression).
 */
function projectBlock(
  block: BlockAssemblySourceBlock,
  includeSpatial: boolean,
): BlockAssemblyInputBlock {
  const tree = block.structured;
  const promptText = tree?.prompt_text ?? '';
  const projected: BlockAssemblyInputBlock = {
    block_id: block.id,
    question_no: tree?.question_no ?? null,
    prompt_head: promptText.slice(0, PROMPT_HEAD_CHARS),
    role: tree?.role ?? null,
    sub_question_count: tree?.sub_questions?.length ?? 0,
    layout_quality: block.layout_quality,
  };
  if (includeSpatial) {
    const firstSpan = block.page_spans?.[0];
    if (firstSpan !== undefined) {
      projected.page_index = firstSpan.page_index;
    }
  }
  return projected;
}

/**
 * Runs the BlockAssembly pass for one ingestion session: projects each draft
 * block to a compact text view, calls `runBlockAssemblyTask`, and maps each
 * candidate → `writeBlockMergeProposal`. Returns the written proposal ids.
 *
 * AI failure is NOT caught here — the caller (`runAutoEnrollForSession`) swallows
 * `BlockAssemblyTaskError` so merge proposals never abort enrollment (§3). The
 * producer ONLY proposes; `mergeQuestions` runs on user accept (§5 hard boundary).
 */
export async function runBlockAssemblyForSession(
  db: Db | Tx,
  params: RunBlockAssemblyForSessionParams,
): Promise<RunBlockAssemblyForSessionResult> {
  // A merge needs at least two blocks; a 0/1-block session has nothing to assemble.
  if (params.blocks.length < 2) {
    return { proposed: 0, proposal_ids: [] };
  }

  // YUK-227 S3 Slice A (F4): enable spatial projection only when the session
  // has at least one block with a real (non-placeholder) page_index. All-zero
  // sessions (Tencent fallback path) skip spatial projection → semantic-only.
  const includeSpatial = !isAllPlaceholderPageIndex(params.blocks);

  const input: BlockAssemblyInput = {
    ingestion_session_id: params.sessionId,
    blocks: params.blocks.map((b) => projectBlock(b, includeSpatial)),
  };

  const output = await runBlockAssemblyTask({
    input,
    runTaskFn: params.runTaskFn,
    ctx: params.ctx,
  });

  // Drop candidates referencing block ids outside this session's draft set: a
  // hallucinating model can emit a primary/merge id that does not exist (or
  // belongs to another session). acceptBlockMergeProposal would later soft-reject
  // these as stale via mergeQuestions' guards, but filtering them here keeps
  // hallucinated proposals out of the inbox (and the accept-side stale path).
  const validBlockIds = new Set(params.blocks.map((b) => b.id));

  const proposalIds: string[] = [];
  for (const candidate of output.candidates) {
    const refsInSession =
      validBlockIds.has(candidate.primary_block_id) &&
      candidate.merge_block_ids.every((id) => validBlockIds.has(id));
    if (!refsInSession) {
      console.warn(
        `[block_assembly] dropping candidate with block ids outside session ${params.sessionId}`,
        { primary: candidate.primary_block_id, merge: candidate.merge_block_ids },
      );
      continue;
    }
    const id = await writeBlockMergeProposal(db, {
      ingestion_session_id: params.sessionId,
      primary_block_id: candidate.primary_block_id,
      merge_block_ids: candidate.merge_block_ids,
      confidence: candidate.confidence,
      continuity_signal: candidate.signal,
      reason_md: candidate.reason_md,
    });
    proposalIds.push(id);
  }

  return { proposed: proposalIds.length, proposal_ids: proposalIds };
}
