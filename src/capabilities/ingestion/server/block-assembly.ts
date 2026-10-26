/**
 * BlockAssembly producer: asks the model which adjacent draft blocks of one session
 * are actually one split question, and writes a `block_merge` proposal per candidate.
 * It only proposes; `mergeQuestions` runs on user accept.
 *
 * Adjacency is the caller's block array order. Spatial signals are used
 * only when a session has real page indices; all-placeholder sessions (Tencent
 * fallback) stay semantic-only. The model works on text, not page images.
 */
import {
  BlockAssemblyCandidate,
  type BlockAssemblyCandidateT,
  BlockAssemblyOutput,
  type BlockAssemblyOutputT,
  BlockAssemblyTaskError,
  parseBlockAssemblyOutput,
} from '@/capabilities/ingestion/tasks/block-assembly';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { writeBlockMergeProposal } from '@/kernel/proposals/producers';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { redactIngestionText } from './privacy-guard';

// Re-exported task schema and error. The session pass and its auto_enroll caller
// swallow the error: merge proposals are best-effort and must not abort enrollment.
export {
  BlockAssemblyCandidate,
  type BlockAssemblyCandidateT,
  BlockAssemblyOutput,
  type BlockAssemblyOutputT,
  BlockAssemblyTaskError,
};

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
  /** Present only on sessions with real page indices, not all-placeholder ones. */
  page_index?: number;
}

export interface BlockAssemblyInput {
  ingestion_session_id: string;
  /** Draft blocks in caller order; adjacency follows this array. */
  blocks: BlockAssemblyInputBlock[];
}

export interface RunBlockAssemblyTaskParams {
  input: BlockAssemblyInput;
  /** Database bound by the production runner; tests may inject runTaskFn instead. */
  db?: Db | Tx;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: BlockAssemblyRunTaskFn;
  /** Forwarded to runTask ctx (subjectProfile only). */
  ctx?: unknown;
}

/**
 * Runs the task and validates its output. Throws BlockAssemblyTaskError on provider
 * failure or unparseable output so the session pass can swallow it.
 */
export async function runBlockAssemblyTask(
  params: RunBlockAssemblyTaskParams,
): Promise<BlockAssemblyOutputT> {
  if (params.runTaskFn === undefined && params.db === undefined) {
    throw new BlockAssemblyTaskError(
      'runBlockAssemblyTask requires db when using the default runner',
    );
  }
  // Audit writes need the root Db; transactional callers must inject runTaskFn.
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db as Db);
  // Redact identifiers before the extracted text reaches the model.
  const input: BlockAssemblyInput = {
    ...params.input,
    blocks: params.input.blocks.map((block) => ({
      ...block,
      prompt_head: redactIngestionText(block.prompt_head).text,
    })),
  };
  let llmText: string;
  try {
    const result = await runTaskFn('BlockAssemblyTask', input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new BlockAssemblyTaskError('BlockAssemblyTask LLM call failed', { cause: err });
  }

  let parsed: BlockAssemblyOutputT;
  try {
    parsed = parseBlockAssemblyOutput(llmText);
  } catch (err) {
    if (err instanceof BlockAssemblyTaskError) throw err;
    throw new BlockAssemblyTaskError(
      'BlockAssemblyTask output did not match BlockAssemblyOutput schema',
      { cause: err },
    );
  }
  return parsed;
}

/** A draft block as loaded by the auto_enroll pass. */
export interface BlockAssemblySourceBlock {
  id: string;
  structured: StructuredQuestionT | null;
  layout_quality: string | null;
  /** The first span's page_index drives spatial matching; all-zero sessions skip it. */
  page_spans?: Array<{
    page_index: number;
    bbox: { x: number; y: number; width: number; height: number };
    role?: string;
  }>;
}

export interface RunBlockAssemblyForSessionParams {
  sessionId: string;
  /** Draft blocks in caller order. */
  blocks: BlockAssemblySourceBlock[];
  /** Inject in tests; defaults to the production BlockAssemblyTask invoker. */
  runTaskFn?: BlockAssemblyRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

export interface RunBlockAssemblyForSessionResult {
  proposed: number;
  proposal_ids: string[];
}

// Prompt head per block; long stems can hide late continuity cues, which page_index
// may resolve when available.
const PROMPT_HEAD_CHARS = 400;

const OPAQUE_BLOCK_REF_RE = /block-[a-z0-9]{12,}|[a-z]+:[a-z0-9:_-]{8,}|\b[a-z0-9]{20,}\b/g;

// Deterministic page-claim cleanup, no model calls. A field-anchored page_index
// becomes 「第 n+1 页」 only when n is a real session page; otherwise it degrades to
// 「某页」. All-placeholder sessions suppress every specific page claim because the
// model never saw page numbers. Bare page_index tokens lose the internal field name.
const PAGE_INDEX_FIELD_VALUE_RE = /page_index\s*(?:均为|都是|等于|是|为|[:：=])\s*(\d{1,4})/g;
const ENUMERATED_PAGE_CLAIM_RE = /第\s*\d{1,4}(?:\s*[、,，到]\s*\d{1,4})+\s*页/g;
const SINGLE_PAGE_CLAIM_RE = /第\s*\d{1,4}\s*页/g;
const PAGE_INDEX_TOKEN_RE = /page_index/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readableBlockLabel(block: BlockAssemblySourceBlock, index: number): string {
  const questionNo = block.structured?.question_no?.trim();
  return questionNo ? `第 ${index + 1} 块（题号 ${questionNo}）` : `第 ${index + 1} 块`;
}

/**
 * Proposal reasons are learner-facing prose, not an audit surface: replace block
 * ids with session positions and mask unknown opaque ids, then drop page claims the
 * session cannot ground. Typed ids stay in proposed_change/evidence_refs.
 */
export function humanizeBlockMergeReason(
  reason: string,
  blocks: BlockAssemblySourceBlock[],
): string {
  let readable = reason;
  for (const [index, block] of blocks.entries()) {
    const token = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(block.id)}(?![A-Za-z0-9_-])`, 'g');
    readable = readable.replace(token, () => readableBlockLabel(block, index));
  }
  readable = readable.replace(OPAQUE_BLOCK_REF_RE, '某题块');

  const knownPageIndices = new Set<number>();
  if (!isAllPlaceholderPageIndex(blocks)) {
    for (const block of blocks) {
      const firstSpan = block.page_spans?.[0];
      if (firstSpan) knownPageIndices.add(firstSpan.page_index);
    }
  }
  readable = readable.replace(PAGE_INDEX_FIELD_VALUE_RE, (_match, raw: string) => {
    const value = Number(raw);
    if (knownPageIndices.size > 0 && knownPageIndices.has(value)) {
      return `第 ${value + 1} 页`;
    }
    return '某页';
  });
  if (knownPageIndices.size === 0) {
    // Page numbers were never in the model input. Replace the enumerated form
    // first so a leftover single form cannot leave dangling punctuation.
    readable = readable.replace(ENUMERATED_PAGE_CLAIM_RE, '页面');
    readable = readable.replace(SINGLE_PAGE_CLAIM_RE, '页面');
  }
  return readable.replace(PAGE_INDEX_TOKEN_RE, '页码');
}

/**
 * True when every block has a placeholder first page_index of 0 (or no spans), so
 * spatial projection is skipped and the model reasons semantically. A single real
 * index enables spatial projection for the session.
 */
export function isAllPlaceholderPageIndex(blocks: BlockAssemblySourceBlock[]): boolean {
  return blocks.every((b) => {
    const firstSpan = b.page_spans?.[0];
    return !firstSpan || firstSpan.page_index === 0;
  });
}

/**
 * Projects a draft block to the compact text view. With `includeSpatial`, the first
 * page span adds page_index so the model can use page continuity.
 */
export function projectBlock(
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
 * Runs the pass for one session, projecting blocks and writing one proposal per
 * candidate. Task errors are left to the caller, which swallows them; this only
 * proposes and never merges.
 */
export async function runBlockAssemblyForSession(
  db: Db | Tx,
  params: RunBlockAssemblyForSessionParams,
): Promise<RunBlockAssemblyForSessionResult> {
  if (params.blocks.length < 2) {
    return { proposed: 0, proposal_ids: [] };
  }

  // All-placeholder sessions (Tencent fallback) stay semantic-only.
  const includeSpatial = !isAllPlaceholderPageIndex(params.blocks);

  const input: BlockAssemblyInput = {
    ingestion_session_id: params.sessionId,
    blocks: params.blocks.map((b) => projectBlock(b, includeSpatial)),
  };

  const output = await runBlockAssemblyTask({
    input,
    db,
    runTaskFn: params.runTaskFn,
    ctx: params.ctx,
  });

  // Drop ids outside the session draft set so hallucinated proposals never reach
  // the inbox; accept-side guards alone would only reject them later.
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
      reason_md: humanizeBlockMergeReason(candidate.reason_md, params.blocks),
    });
    proposalIds.push(id);
  }

  return { proposed: proposalIds.length, proposal_ids: proposalIds };
}
