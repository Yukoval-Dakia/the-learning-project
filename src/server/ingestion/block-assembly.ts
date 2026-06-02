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
 * DECISIVE CONSTRAINT — spatial signal is DEFERRED (§0). `question_block.page_spans`
 * is all placeholder today (page_index=0, full-page bbox; precise bbox = slice 2b,
 * DEFERRED). So path-B v1 is SEMANTIC-ONLY: the model judges merge candidates from
 * the projected `structured` tree (question_no continuity, sub-question carry-over,
 * stem/answer split, "承接前题/根据上文" cues), NOT from bbox/page-edge spatial
 * signals. Adjacency = the natural session block array order (INSERT order); there
 * is no ordering column. bbox-based page-edge detection layers in later when slice
 * 2b lands (the task just gains a spatial input — no rework here).
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
// long stems; slice 2b (when spatial signals land) may make this layout_quality-
// aware (longer head for long-form / cross-page blocks). Tune here, not inline.
const PROMPT_HEAD_CHARS = 400;

/**
 * Project one draft block's structured tree to the compact text view the model
 * reasons over (§2 input projection). page_spans page_index is placeholder=0
 * (§0: SEMANTIC-ONLY — spatial input is DEFERRED to slice 2b), so it is NOT
 * projected here; the model judges merges from numbering / carry-over / stem-
 * answer-split cues, not from spatial signals.
 */
function projectBlock(block: BlockAssemblySourceBlock): BlockAssemblyInputBlock {
  const tree = block.structured;
  const promptText = tree?.prompt_text ?? '';
  return {
    block_id: block.id,
    question_no: tree?.question_no ?? null,
    prompt_head: promptText.slice(0, PROMPT_HEAD_CHARS),
    role: tree?.role ?? null,
    sub_question_count: tree?.sub_questions?.length ?? 0,
    layout_quality: block.layout_quality,
  };
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

  const input: BlockAssemblyInput = {
    ingestion_session_id: params.sessionId,
    blocks: params.blocks.map(projectBlock),
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
