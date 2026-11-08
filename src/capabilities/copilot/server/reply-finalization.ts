import { createHash } from 'node:crypto';
import type { AfterToolCallResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { BLOCK_PLACE_PATTERN, ChartBlock, serializeBlockFence } from '@/core/schema/blocks';
import type { PiAfterToolCall, PiBeforeToolCall, PiHookBridge } from '@/core/tool-call-contract';
import { bindChartSeries, chartSeriesIssues } from '@/kernel/blocks/chart';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export { CopilotPrimaryViewSchema } from '../primary-view-contract';

import type { ProviderFailureInfo } from '@/ai/provider-failure';
import type {
  ProposalEffectContract,
  ToolExecutionGateInput,
  ToolExecutionResultObservation,
} from '@/kernel/tools/types';
import {
  COPILOT_FINALIZATION_FAILURE_REPLY,
  providerFailureToPublicFailure,
  publicProseFailureMessage,
} from '../public-prose-contract';
import type { CopilotCorrectionContract } from './correction-contract';
import { resolveCorrectionReply } from './correction-contract';
import { stripCopilotInternalComments } from './prose-stream';

// Uncapped by owner directive. Kept as a named bound because the receipt schema
// derives its `.max()` from it and the beforeToolCall gate reads it;
// MAX_SAFE_INTEGER makes both inert while keeping the receipt finite and
// JSON-serializable.
export const COPILOT_REPLY_TRACE_MAX_CALLS = Number.MAX_SAFE_INTEGER;

export const COPILOT_REPLY_CHAR_LIMIT = 64_000;

export function truncateCopilotReply(
  text: string,
  limit = COPILOT_REPLY_CHAR_LIMIT,
  retainedTail = '',
): string {
  if (text.length <= limit) return text;
  const disclosure =
    text.match(
      /<!--copilot-proposal-disclosure:start-->[\s\S]*?<!--copilot-proposal-disclosure:end-->\s*$/,
    )?.[0] ?? '';
  let body = disclosure ? text.slice(0, text.length - disclosure.length).trimEnd() : text;
  const tail = retainedTail.trim();
  if (tail && body.endsWith(tail)) body = body.slice(0, -tail.length).trimEnd();
  const suffix = [`> 回答过长，已截断于 ${limit} 字。`, tail, disclosure]
    .filter(Boolean)
    .join('\n\n');
  return `${body.slice(0, Math.max(0, limit - suffix.length - 2))}\n\n${suffix}`;
}

// YUK-1548 — extractPrimaryView (the retired <!--primary_view:--> marker) was
// deleted in slice 1. Model-nominated primary views are retired; only persisted
// historical views are read, by turns.ts and the companion UI.

export const CopilotReplyFinalizationReceiptSchema = z
  .object({
    protocol_version: z.literal(2),
    assurance: z.enum(['execution_trace_bound', 'unsealed']),
    unsealed_reason: z
      .enum([
        'reply_truncated',
        'incomplete_tool_trace',
        'trace_changed',
        'finalization_error',
        'provider_failure',
        'missing_terminal',
      ])
      .optional(),
    root_task_run_id: z.string().min(1),
    candidate_sha256: z.string().length(64),
    reply_sha256: z.string().length(64),
    trace_sha256: z.string().length(64),
    trace_call_count: z.number().int().min(0).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    observed_completed_tool_use_ids: z.array(z.string().min(1)).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    correction: z.enum(['normal', 'clarify', 'corrected']),
    proposal_disclosure: z.enum(['none', 'server_composed']),
    primary_view: z.enum(['absent', 'retained', 'dropped']).optional(),
    /** YUK-1548 §5 — block placement receipt (only when compose_block ran). */
    blocks: z
      .object({
        placed: z.number().int().min(0),
        appended: z.number().int().min(0),
        dropped: z.number().int().min(0),
        unplaced: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CopilotReplyFinalizationReceipt = z.infer<typeof CopilotReplyFinalizationReceiptSchema>;

export interface PreparedCopilotReply {
  text: string;
}

interface TraceEntry {
  ordinal: number;
  tool_use_id: string;
  tool_name: string;
  input_sha256: string;
  output_sha256: string | null;
  status: 'in_flight' | 'succeeded' | 'failed';
  effect: ToolExecutionResultObservation['effect'] | null;
  root_call: boolean;
  proposal_effect_contract?: ProposalEffectContract;
  domain_output?: unknown;
  domain_executed?: boolean;
}

export interface CopilotReplyFinalizationResult {
  replyText: string;
  preparedReply: PreparedCopilotReply;
  receipt: CopilotReplyFinalizationReceipt;
  accepted: boolean;
}

export interface CreateCopilotReplyFinalizerOptions {
  rootTaskRunId: string;
  correctionContract: CopilotCorrectionContract;
  /** Deterministic service reply that supersedes model prose for this turn. */
  authoritativeReply?: { reply: string; correction: 'clarify' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** pi tool errors surface as content-block arrays; reduce to the text the SDK
 *  `PostToolUseFailure.error` string would have carried. */
export function piToolErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (Array.isArray(error)) {
    const text = error
      .map((block) =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '',
      )
      .filter((part) => part.length > 0)
      .join('\n');
    if (text.length > 0) return text;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The placement note is one server-authored fact. Recognize the model's verbatim copy
 *  even when it trims the explanatory prefix, so the learner reads it once. */
function replyStatesPlacement(reply: string, placementNote: string): boolean {
  if (reply.includes(placementNote)) return true;
  const placed = placementNote.match(/这道题先?放在「[^」]+」下/u)?.[0];
  return placed !== undefined && placed.length > 0 && reply.includes(placed);
}

const NO_EXECUTOR_ADMISSION =
  '这类题目前没有可用的自动判分器，暂时不能作答；可以换一道选择、填空、配对、断句或排序题。';
const PENDING_ADMISSION = '自动检查通过后才能作答；当前状态和原因可在题库查看。';

function proposalDisclosure(
  trace: readonly TraceEntry[],
  reply: string,
  inlineCardQuestionIds: ReadonlySet<string> = new Set(),
): string | undefined {
  // One disclosure per question, never a cross-question dedupe: a different
  // question must not swallow this question's warning.
  const seenBankPaths = new Set<string>();
  const seenFailureDetails = new Set<string>();
  let pendingStatus = false;
  const bankLinks = trace.flatMap((entry) => {
    const out = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    const problem = isRecord(out?.problem) ? out.problem : undefined;
    if (
      out?.seed_mode === 'teaching_draft' &&
      out.status === 'failed' &&
      (problem?.code === 'subject_root_missing' || problem?.code === 'conversation_required') &&
      typeof problem.detail === 'string'
    ) {
      if (seenFailureDetails.has(problem.detail)) return [];
      seenFailureDetails.add(problem.detail);
      // Model prose owns the explanation; the server only supplies the exact fact it omitted.
      return reply.includes(problem.detail) ? [] : [problem.detail];
    }
    if (
      entry.status !== 'succeeded' ||
      out?.seed_mode !== 'teaching_draft' ||
      out.status !== 'submitted' ||
      typeof out.bank_path !== 'string'
    )
      return [];
    if (seenBankPaths.has(out.bank_path)) return [];
    seenBankPaths.add(out.bank_path);
    const bankPath = out.bank_path;
    const bankQuestionId = bankPath.startsWith('/questions/')
      ? bankPath.slice('/questions/'.length)
      : undefined;
    const inlineCardShown =
      bankQuestionId !== undefined && inlineCardQuestionIds.has(bankQuestionId);
    const admission = isRecord(out.admission) ? out.admission : undefined;
    const noExecutor =
      Array.isArray(admission?.per_unit) &&
      admission.per_unit.some((unit) => isRecord(unit) && unit.reason === 'no_admitted_executor');
    const placementNote = typeof out.placement_note === 'string' ? out.placement_note : undefined;
    const missingPlacement =
      placementNote !== undefined && !replyStatesPlacement(reply, placementNote);
    const admissionSentence = noExecutor ? NO_EXECUTOR_ADMISSION : PENDING_ADMISSION;
    const linkStated = reply.includes(bankPath);
    // Warning and link are separate facts. A warning counts as stated for this
    // question only when the full sentence and this question's bank_path share a
    // line; a phrase quoted for another question cannot suppress it.
    const warningStated =
      noExecutor &&
      reply.split('\n').some((line) => line.includes(bankPath) && line.includes(admissionSentence));
    const admitted = admission?.state === 'admitted';
    const facts: string[] = [];
    if (missingPlacement && placementNote !== undefined) facts.push(placementNote);
    if (noExecutor) {
      if (!warningStated) facts.push(`题已存入[题库](${bankPath})，但${admissionSentence}`);
    } else {
      // Admission state is server-owned: append one deterministic sentence per
      // reply instead of matching whatever wording the model chose. A visible
      // inline question card already carries the status, so do not repeat it;
      // the bank link stays because those card states do not open the question.
      if (!linkStated) facts.push(`题已存入[题库](${bankPath})。`);
      if (!admitted && !inlineCardShown) pendingStatus = true;
    }
    return facts.length > 0 ? [facts.join('\n')] : [];
  });
  // One status sentence covers every ordinary question still under check.
  if (pendingStatus) bankLinks.push(PENDING_ADMISSION);
  const proposals = trace.filter((entry) => entry.proposal_effect_contract !== undefined);
  if (proposals.length === 0) return bankLinks.length ? bankLinks.join('\n') : undefined;
  const retainedDrafts = proposals.filter(
    (entry) => entry.proposal_effect_contract?.retained_draft,
  ).length;
  const pending = proposals.filter((entry) => {
    const output = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    const status = typeof output?.status === 'string' ? output.status : undefined;
    return (
      entry.status === 'succeeded' &&
      status !== undefined &&
      status !== 'failed' &&
      !status.startsWith('skipped:')
    );
  });
  // auto_apply is the tool's own fact about the proposal it just wrote — a
  // creation-time marker, not a later lookup. Every pending proposal must
  // carry it before the headline may say the change applies itself.
  const autoApplies = (entry: (typeof pending)[number]) => {
    const output = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    return output?.auto_apply === true;
  };
  const allAutoApply = pending.length > 0 && pending.every(autoApplies);
  const duplicatePending = proposals.some((entry) => {
    const output = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    return output?.status === 'skipped:duplicate_pending';
  });
  return [
    '<!--copilot-proposal-disclosure:start-->',
    pending.length === 0
      ? duplicatePending
        ? '同样的建议之前已提交，这轮没有新建，未执行目标变更。'
        : '本轮没有产生可供确认的建议，未执行目标变更。'
      : allAutoApply
        ? '本轮建议已记下，会自动生效；还没被用到的可以撤销。'
        : '本轮建议已提交，等待你确认后才会应用到目标。',
    // The companion reads these hidden rows to retain its inbox notice.
    ...(pending.length > 0
      ? [
          '<!--',
          ...pending.map(
            (entry) => `- \`建议\`: status=${autoApplies(entry) ? 'auto_apply' : 'pending'}`,
          ),
          '-->',
        ]
      : []),
    ...(retainedDrafts > 0 ? ['生成的草稿已经保存；暂不采纳建议也不会删除草稿。'] : []),
    '<!--copilot-proposal-disclosure:end-->',
    ...bankLinks,
  ].join('\n');
}

function applyProposalDisclosure(text: string, disclosure?: string): string {
  const stripped = text
    .replace(
      /\n*<!--copilot-proposal-disclosure:start-->[\s\S]*?<!--copilot-proposal-disclosure:end-->\n*/g,
      '\n\n',
    )
    .trimEnd();
  return disclosure ? `${stripped}\n\n${disclosure}` : stripped;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestTrace(trace: readonly TraceEntry[]): string {
  return sha256CanonicalJson(trace.map(({ domain_output: _output, ...entry }) => entry));
}

function domainToolName(toolName: string): string {
  const separator = toolName.lastIndexOf('__');
  return separator === -1 ? toolName : toolName.slice(separator + 2);
}

/**
 * The recorded value behind a chart's tool_result binding. Same gate as the hero
 * nomination, plus the producer's declared chart_bindings: a successful call is
 * not statistical evidence just because its JSON looks like a series. compose_block
 * output carries no chart_bindings, so it can never launder its own series.
 */
function chartBindingOutput(
  trace: readonly TraceEntry[],
  toolUseId: string,
  path: string,
): unknown | undefined {
  const entry = trace.find(
    (candidate) =>
      candidate.tool_use_id === toolUseId &&
      candidate.root_call &&
      candidate.status === 'succeeded' &&
      candidate.domain_executed === true &&
      candidate.effect !== 'control',
  );
  if (!entry) return undefined;
  const output = entry.domain_output;
  const declared =
    isRecord(output) && Array.isArray(output.chart_bindings)
      ? output.chart_bindings.filter((value): value is string => typeof value === 'string')
      : [];
  if (!declared.includes(path)) return undefined;
  return entry.output_sha256 === sha256CanonicalJson(entry.domain_output)
    ? entry.domain_output
    : undefined;
}

export function createCopilotReplyFinalizer(options: CreateCopilotReplyFinalizerOptions) {
  const trace: TraceEntry[] = [];
  const byId = new Map<string, TraceEntry>();
  let traceVersion = 0;

  const piBeforeToolCall: PiBeforeToolCall = (call, args) => {
    if (trace.length >= COPILOT_REPLY_TRACE_MAX_CALLS) {
      return { block: true, reason: 'Copilot turn tool-call ceiling reached' };
    }
    const entry: TraceEntry = {
      ordinal: trace.length + 1,
      tool_use_id: call.id,
      tool_name: call.name,
      input_sha256: sha256CanonicalJson(args),
      output_sha256: null,
      status: 'in_flight',
      effect: null,
      root_call: call.agentType === undefined,
    };
    trace.push(entry);
    byId.set(entry.tool_use_id, entry);
    traceVersion += 1;
    return undefined;
  };

  const piAfterToolCall: PiAfterToolCall = (observation) => {
    const entry = byId.get(observation.call.id);
    // Domain tools settle through observeDomainTool inside executeDomainToolCall
    // before afterToolCall fires.
    if (entry?.status !== 'in_flight') return undefined;
    entry.status = observation.isError ? 'failed' : 'succeeded';
    entry.output_sha256 = sha256CanonicalJson(
      observation.isError ? { error: piToolErrorText(observation.error) } : observation.output,
    );
    traceVersion += 1;
    const content: NonNullable<AfterToolCallResult['content']> = [
      ...(Array.isArray(observation.output)
        ? (observation.output as NonNullable<AfterToolCallResult['content']>)
        : []),
      {
        type: 'text',
        text: `Internal follow-up reference, not for display: tool_use_id=${observation.call.id}`,
      },
    ];
    return { content };
  };

  function observedCompletedToolUseIds(): string[] {
    return trace
      .filter(
        (entry) => entry.root_call && entry.status === 'succeeded' && entry.output_sha256 !== null,
      )
      .map((entry) => entry.tool_use_id);
  }

  async function finalizeTerminal(
    terminalText: string,
    failure?: ProviderFailureInfo,
    context: { streamedText?: string; retainedTail?: string } = {},
  ): Promise<CopilotReplyFinalizationResult> {
    // A server-owned clarification is the candidate. An empty model terminal
    // or a provider failure must not replace it.
    const authored =
      options.authoritativeReply !== undefined && options.authoritativeReply.reply.trim().length > 0
        ? options.authoritativeReply.reply
        : undefined;
    if (failure !== undefined && authored === undefined) {
      return publishUnsealed(
        terminalText ||
          context.streamedText ||
          publicProseFailureMessage(providerFailureToPublicFailure(failure)),
        'provider_failure',
        context,
      );
    }
    const startVersion = traceVersion;
    const startTraceSha = digestTrace(trace);
    try {
      const terminal = authored ?? terminalText;
      if (terminal.trim().length === 0)
        return publishUnsealed(terminalText, 'missing_terminal', context);
      if (trace.some((entry) => entry.status === 'in_flight' || entry.output_sha256 === null)) {
        return publishUnsealed(terminal, 'incomplete_tool_trace', context);
      }
      const candidateSha = sha256Text(terminal);
      const presentedText = terminal;
      const correction = resolveCorrectionReply(presentedText, options.correctionContract);
      if (correction.reply.trim().length === 0) {
        return publishUnsealed('', 'missing_terminal', context);
      }
      // Strip old disclosure markers while they are still comments, then clear
      // other internal comments, and only then parse block placements. A card
      // hidden inside an HTML comment must not count as placed.
      const withoutOldDisclosure = stripCopilotInternalComments(
        applyProposalDisclosure(correction.reply),
      ).trimEnd();
      const prepared = prepareReplyText(withoutOldDisclosure);
      const disclosure = proposalDisclosure(trace, prepared.text, prepared.inlineCardQuestionIds);
      const disclosed = applyProposalDisclosure(prepared.text, disclosure);
      const fixed = truncateCopilotReply(disclosed, COPILOT_REPLY_CHAR_LIMIT, context.retainedTail);
      const truncated = fixed !== disclosed;
      if (
        traceVersion !== startVersion ||
        digestTrace(trace) !== startTraceSha ||
        trace.some((entry) => entry.status === 'in_flight')
      ) {
        return publishUnsealed(terminalText, 'trace_changed', context);
      }
      const receipt: CopilotReplyFinalizationReceipt = {
        protocol_version: 2,
        assurance: truncated ? 'unsealed' : 'execution_trace_bound',
        ...(truncated ? { unsealed_reason: 'reply_truncated' as const } : {}),
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: candidateSha,
        reply_sha256: sha256Text(fixed),
        trace_sha256: startTraceSha,
        trace_call_count: trace.length,
        observed_completed_tool_use_ids: observedCompletedToolUseIds(),
        correction: options.authoritativeReply?.correction ?? correction.kind,
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        ...(prepared.blocksReceipt ? { blocks: prepared.blocksReceipt } : {}),
      };
      return {
        replyText: fixed,
        preparedReply: { text: fixed },
        receipt,
        accepted: true,
      };
    } catch {
      return publishUnsealed(authored ?? terminalText, 'finalization_error', context);
    }
  }

  function observeDomainTool(result: ToolExecutionResultObservation): void {
    const id = result.tool_use_id;
    if (!id) return;
    const entry = byId.get(id);
    if (entry?.status !== 'in_flight' || domainToolName(entry.tool_name) !== result.name) return;
    // Capture the observed value once so a caller retaining the mutable output
    // cannot change a nomination or displayed result behind its trace hash.
    const output = structuredClone(result.output);
    entry.effect = result.effect;
    entry.status = result.error_reason === null ? 'succeeded' : 'failed';
    entry.output_sha256 = sha256CanonicalJson(output);
    entry.proposal_effect_contract = result.proposal_effect_contract;
    entry.domain_output = output;
    entry.domain_executed = result.executed;
    traceVersion += 1;
  }

  function prepareReplyText(text: string) {
    // YUK-1548 — only compose_block may mint tlp-block fences. Neutralise
    // hand-written ones before substitution (render as inert code).
    const withDisclosure = text.replace(
      /^([^\S\n]*(?:`{3,}|~{3,})[^\S\n]*)tlp-block\b[^\n]*$/gim,
      '$1text',
    );
    // YUK-1548 §5 — resolve `![alt](block:<ref>)` placements against the
    // successful root compose_block calls bound to this trace, substitute
    // canonical tlp-block fences, and append never-placed blocks in order.
    const readyBlocks = trace
      .filter(
        (entry) =>
          entry.root_call &&
          entry.status === 'succeeded' &&
          entry.domain_executed === true &&
          domainToolName(entry.tool_name) === 'compose_block',
      )
      .flatMap((entry) => {
        const output = entry.domain_output as
          | { status?: string; ref?: string; block?: unknown }
          | undefined;
        if (output?.status !== 'ready' || typeof output.ref !== 'string') return [];
        const raw = output.block;
        if (!raw || typeof raw !== 'object' || (raw as { kind?: unknown }).kind !== 'chart') {
          return [{ ref: output.ref, block: raw }];
        }
        // A chart is published only with the recorded values behind its binding;
        // the model's own series are never the authority for tool_result data.
        // The fence carries no ref: the compose ref is a draft placement token,
        // so re-deriving the block here cannot leave a stale persisted ref.
        const chart = ChartBlock.safeParse(raw);
        if (!chart.success || chartSeriesIssues(chart.data).length > 0) return [];
        if (chart.data.data_source.kind === 'model') {
          return [{ ref: output.ref, block: chart.data }];
        }
        const recorded = chartBindingOutput(
          trace,
          chart.data.data_source.tool_use_id,
          chart.data.data_source.path,
        );
        if (recorded === undefined) return [];
        const bound = bindChartSeries(chart.data, recorded);
        return bound.ok ? [{ ref: output.ref, block: bound.block }] : [];
      });
    const blocksByRef = new Map(readyBlocks.map((b) => [b.ref, b.block]));
    const placedRefs = new Set<string>();
    let dropped = 0;
    const withPlaced = withDisclosure.replace(BLOCK_PLACE_PATTERN, (_match, _alt, ref: string) => {
      if (!blocksByRef.has(ref)) {
        dropped += 1;
        return '';
      }
      placedRefs.add(ref);
      return `\n\n${serializeBlockFence(blocksByRef.get(ref) as never)}\n\n`;
    });
    // Superseded compose drafts never reach the learner: once the reply
    // places at least one block, every other ready block is dropped; with no
    // placement at all, only the last ready block per kind is appended. The
    // rest are recorded as `unplaced` in the receipt.
    const unplacedBlocks = readyBlocks.filter((b) => !placedRefs.has(b.ref));
    let appended: typeof unplacedBlocks;
    let unplaced: number;
    if (placedRefs.size > 0) {
      appended = [];
      unplaced = unplacedBlocks.length;
    } else {
      const lastIndexByKind = new Map<string, number>();
      unplacedBlocks.forEach((b, index) => {
        const kind = (b.block as { kind?: unknown } | undefined)?.kind;
        lastIndexByKind.set(typeof kind === 'string' ? kind : '', index);
      });
      const kept = new Set(lastIndexByKind.values());
      appended = unplacedBlocks.filter((_, index) => kept.has(index));
      unplaced = unplacedBlocks.length - appended.length;
    }
    const appendedFences = appended.map((b) => serializeBlockFence(b.block as never)).join('\n\n');
    const composed = appendedFences ? `${withPlaced.trimEnd()}\n\n${appendedFences}` : withPlaced;
    const inlineCardQuestionIds = new Set<string>();
    for (const { block } of [...readyBlocks.filter((b) => placedRefs.has(b.ref)), ...appended]) {
      const candidate = block as {
        kind?: unknown;
        display?: unknown;
        question_ids?: unknown;
      };
      if (
        candidate.kind !== 'question_ref' ||
        candidate.display !== 'inline' ||
        !Array.isArray(candidate.question_ids)
      )
        continue;
      for (const id of candidate.question_ids) {
        if (typeof id === 'string') inlineCardQuestionIds.add(id);
      }
    }
    const blocksReceipt =
      readyBlocks.length > 0 || dropped > 0
        ? { placed: placedRefs.size, appended: appended.length, dropped, unplaced }
        : undefined;
    return { text: composed, blocksReceipt, inlineCardQuestionIds };
  }

  function publishUnsealed(
    candidate: string,
    reason: NonNullable<CopilotReplyFinalizationReceipt['unsealed_reason']>,
    context: { streamedText?: string; retainedTail?: string },
  ): CopilotReplyFinalizationResult {
    const candidateBody = stripCopilotInternalComments(applyProposalDisclosure(candidate));
    const streamedBody = stripCopilotInternalComments(
      applyProposalDisclosure(context.streamedText ?? ''),
    );
    const body = candidateBody.trim()
      ? candidateBody
      : streamedBody.trim()
        ? streamedBody
        : COPILOT_FINALIZATION_FAILURE_REPLY;
    const prepared = prepareReplyText(body);
    const disclosure = proposalDisclosure(trace, prepared.text, prepared.inlineCardQuestionIds);
    const replyText = truncateCopilotReply(
      applyProposalDisclosure(prepared.text, disclosure),
      COPILOT_REPLY_CHAR_LIMIT,
      context.retainedTail,
    );
    const traceSha = digestTrace(trace);
    return {
      replyText,
      preparedReply: { text: replyText },
      accepted: true,
      receipt: {
        protocol_version: 2,
        assurance: 'unsealed',
        unsealed_reason: reason,
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: sha256Text(candidate),
        reply_sha256: sha256Text(replyText),
        trace_sha256: traceSha,
        trace_call_count: trace.length,
        observed_completed_tool_use_ids: observedCompletedToolUseIds(),
        correction: 'normal',
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        ...(prepared.blocksReceipt ? { blocks: prepared.blocksReceipt } : {}),
      },
    };
  }

  return {
    piHooks: { beforeToolCall: [piBeforeToolCall], afterToolCall: [piAfterToolCall] },
    beforeDomainTool(_tool: ToolExecutionGateInput): string | undefined {
      return trace.length >= COPILOT_REPLY_TRACE_MAX_CALLS
        ? 'Copilot turn tool-call ceiling reached'
        : undefined;
    },
    observeDomainTool,
    finalizeTerminal,
  };
}

/** Finalizer entries run before the caller's bridge entries in both directions. */
export function prependCopilotPiFinalizationHooks(
  finalizerHooks: PiHookBridge,
  existing?: PiHookBridge,
): PiHookBridge {
  return {
    beforeToolCall: [...(finalizerHooks.beforeToolCall ?? []), ...(existing?.beforeToolCall ?? [])],
    afterToolCall: [...(finalizerHooks.afterToolCall ?? []), ...(existing?.afterToolCall ?? [])],
  };
}
