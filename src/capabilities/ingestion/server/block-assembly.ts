/**
 * BlockAssembly producer: asks the model which adjacent draft blocks of one session
 * are actually one split question, and writes a `block_merge` proposal per candidate.
 * It only proposes; `mergeQuestions` runs on user accept.
 *
 * Adjacency is the caller's block array order. Spatial signals are used
 * only when a session has real page indices; all-placeholder sessions (Tencent
 * fallback) stay semantic-only. The model works on text, not page images.
 */

import { eq } from 'drizzle-orm';
import {
  BlockAssemblyCandidate,
  type BlockAssemblyCandidateT,
  BlockAssemblyOutput,
  type BlockAssemblyOutputT,
  BlockAssemblyTaskError,
  parseBlockAssemblyOutput,
} from '@/capabilities/ingestion/tasks/block-assembly';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeBlockMergeProposal } from '@/kernel/proposals/producers';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import {
  type IngestionRedactionField,
  redactIngestionText,
  writeIngestionUsageReceipt,
} from './privacy-guard';

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
  /**
   * The source document the session's content is sent under. When present the
   * policy is enforced at the send boundary and the attempted send writes a
   * usage receipt; when absent (no resolvable document) the send proceeds under
   * a document that never declared a policy and no receipt can be anchored.
   */
  usage?: {
    sourceDocumentId: string;
    sessionId: string;
    derivationPolicy: DerivationPolicyT;
  };
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
  // A restricted document is never sent — redaction does not exempt the send.
  if (params.usage !== undefined && params.usage.derivationPolicy !== 'allow') {
    throw new BlockAssemblyTaskError(
      `derivation policy '${params.usage.derivationPolicy}' forbids model use of this document's content`,
    );
  }
  // Redact identifiers before the extracted text reaches the model; the per-block
  // accounting unions into the usage receipt, categories and counts never values.
  const redactedFields = new Set<IngestionRedactionField>();
  const redactedCounts = new Map<IngestionRedactionField, number>();
  const input: BlockAssemblyInput = {
    ...params.input,
    blocks: params.input.blocks.map((block) => {
      const redacted = redactIngestionText(block.prompt_head);
      for (const field of redacted.fields) redactedFields.add(field);
      for (const [field, count] of Object.entries(redacted.counts) as [
        IngestionRedactionField,
        number,
      ][]) {
        redactedCounts.set(field, (redactedCounts.get(field) ?? 0) + count);
      }
      return { ...block, prompt_head: redacted.text };
    }),
  };
  const recordUsage = async () => {
    const usage = params.usage;
    if (usage === undefined || params.db === undefined) return;
    try {
      await writeIngestionUsageReceipt(params.db, {
        sourceDocumentId: usage.sourceDocumentId,
        sessionId: usage.sessionId,
        derivationPolicy: usage.derivationPolicy,
        engine: 'ingestion_block_assembly',
        redactedFields: [...redactedFields].sort(),
        redactionCounts: Object.fromEntries(redactedCounts),
        channels: { page_images: 'none', extracted_text: 'redacted' },
      });
    } catch (err) {
      // The send is already recorded in ai_task_runs; a lost receipt is an
      // observability gap, not a reason to burn a second paid call on retry.
      console.error('[block_assembly] usage receipt write failed', err);
    }
  };
  let llmText: string;
  try {
    const result = await runTaskFn('BlockAssemblyTask', input, params.ctx ?? {});
    llmText = result.text;
    await recordUsage();
  } catch (err) {
    // An attempted send is usage too: receipt first, then the failure surfaces.
    await recordUsage();
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
  /**
   * The bound source document and its already-resolved derivation policy. When
   * absent the policy is re-resolved from the session here, so no caller can
   * bypass the gate by omission.
   */
  usage?: { sourceDocumentId: string | null; derivationPolicy: DerivationPolicyT };
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

  // The usage-policy gate owns the send decision: a restricted document never
  // reaches the model — redaction only shapes what an ALLOWED send looks like.
  // A caller that passed no usage still gets resolved + anchored here.
  const sessionUsage =
    params.usage !== undefined
      ? params.usage
      : await (async () => {
          const [session] = await db
            .select({ source_document_id: learning_session.source_document_id })
            .from(learning_session)
            .where(eq(learning_session.id, params.sessionId))
            .limit(1);
          return {
            sourceDocumentId: session?.source_document_id ?? null,
            derivationPolicy: await resolveSessionDerivationPolicy(db, params.sessionId),
          };
        })();
  if (sessionUsage.derivationPolicy !== 'allow') {
    console.info(
      `[block_assembly] session ${params.sessionId}: derivation policy '${sessionUsage.derivationPolicy}' forbids the send`,
    );
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
    ...(sessionUsage.sourceDocumentId != null
      ? {
          usage: {
            sourceDocumentId: sessionUsage.sourceDocumentId,
            sessionId: params.sessionId,
            derivationPolicy: sessionUsage.derivationPolicy,
          },
        }
      : {}),
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
      // Verbatim model reason. Page evidence stays separate: the inbox resolves
      // each evidence block's page from question_block.page_spans for display.
      reason_md: candidate.reason_md,
    });
    proposalIds.push(id);
  }

  return { proposed: proposalIds.length, proposal_ids: proposalIds };
}
