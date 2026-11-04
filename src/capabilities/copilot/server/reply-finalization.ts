import { createHash } from 'node:crypto';
import type { AfterToolCallResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { BLOCK_PLACE_PATTERN, serializeBlockFence } from '@/core/schema/blocks';
import type { PiAfterToolCall, PiBeforeToolCall, PiHookBridge } from '@/core/tool-call-contract';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export { CopilotPrimaryViewSchema } from '../primary-view-contract';

import type { ProviderFailureInfo } from '@/ai/provider-failure';
import type {
  ProposalEffectContract,
  ToolExecutionGateInput,
  ToolExecutionResultObservation,
} from '@/kernel/tools/types';
import {
  providerFailureToPublicFailure,
  publicProseFailureMessage,
} from '../public-prose-contract';
import type { CopilotCorrectionContract } from './correction-contract';
import { resolveCorrectionReply } from './correction-contract';
import { stripCopilotInternalComments } from './prose-stream';
import { buildCopilotToolResultSnapshot } from './tool-result-snapshot';
import {
  type PresentPrimaryViewInput,
  PresentPrimaryViewOutputSchema,
} from './tools/present-primary-view';
import type { CopilotPrimaryView } from './turns';

// Uncapped by owner directive. Kept as a named bound because the receipt schema
// derives its `.max()` from it and the beforeToolCall gate reads it;
// MAX_SAFE_INTEGER makes both inert while keeping the receipt finite and
// JSON-serializable.
export const COPILOT_REPLY_TRACE_MAX_CALLS = Number.MAX_SAFE_INTEGER;

export const COPILOT_REPLY_CHAR_LIMIT = 64_000;
const FINALIZATION_FAILURE_REPLY = '这次回复没有完成可验证的收口，暂不展示未封存的草稿。请重试。';

export const EPHEMERAL_PRESENTATION_STORAGE_NOTICE =
  '\n\n> 保存说明（系统，以此为准）：这张卡片会随对话保存，重新打开仍可恢复；关闭面板不会删除。它不会另存为独立资料。当前不支持仅临时查看且完全不保存；正文中的其他保存描述不代表实际状态。';

/** Called only at the shared commit boundary, after unsuccessful paths remove the view. */
export function sealCommittedPresentationReply(
  preparedReply: PreparedCopilotReply,
  receipt?: CopilotReplyFinalizationReceipt,
): { preparedReply: PreparedCopilotReply; receipt?: CopilotReplyFinalizationReceipt } {
  const committedReceipt =
    !preparedReply.primaryView && receipt?.primary_view === 'retained'
      ? { ...receipt, primary_view: 'dropped' as const }
      : receipt;
  if (preparedReply.primaryView?.source !== 'ephemeral_html')
    return { preparedReply, receipt: committedReceipt };
  const text = preparedReply.text.endsWith(EPHEMERAL_PRESENTATION_STORAGE_NOTICE)
    ? preparedReply.text
    : preparedReply.text + EPHEMERAL_PRESENTATION_STORAGE_NOTICE;
  return {
    preparedReply: { ...preparedReply, text },
    ...(committedReceipt
      ? { receipt: { ...committedReceipt, reply_sha256: sha256Text(text) } }
      : {}),
  };
}

// YUK-1548 — extractPrimaryView (the retired <!--primary_view:--> marker) was
// deleted in slice 1; nomination only ever comes from the present_primary_view
// tool result bound to the trace below.

export const CopilotReplyFinalizationReceiptSchema = z
  .object({
    protocol_version: z.literal(2),
    assurance: z.literal('execution_trace_bound'),
    root_task_run_id: z.string().min(1),
    candidate_sha256: z.string().length(64),
    reply_sha256: z.string().length(64),
    trace_sha256: z.string().length(64),
    trace_call_count: z.number().int().min(0).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    observed_completed_tool_use_ids: z.array(z.string().min(1)).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    correction: z.enum(['normal', 'clarify', 'corrected']),
    proposal_disclosure: z.enum(['none', 'server_composed']),
    primary_view: z.enum(['absent', 'retained', 'dropped']),
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
  primaryView?: CopilotPrimaryView;
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
  /** Owned live-row validation plus canonical product reference. Null rejects the nomination. */
  resolveArtifactReference: (ref: {
    kind: string;
    id: string;
  }) => Promise<{ kind: string; id: string } | null>;
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

function proposalDisclosure(trace: readonly TraceEntry[]): string | undefined {
  const proposals = trace.filter((entry) => entry.proposal_effect_contract !== undefined);
  if (proposals.length === 0) return undefined;
  const rows = proposals.map((entry) => {
    const output = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    const status = typeof output?.status === 'string' ? output.status : undefined;
    const proposalId = typeof output?.proposal_id === 'string' ? output.proposal_id : undefined;
    const succeeded =
      entry.status === 'succeeded' &&
      status !== undefined &&
      status !== 'failed' &&
      !status.startsWith('skipped:');
    const retained = entry.proposal_effect_contract?.retained_draft;
    return [
      `- \`${entry.tool_name}\`${status ? `: status=${status}` : ''}${proposalId ? `, proposal_id=${proposalId}` : ''}`,
      ...(retained
        ? [`  retained draft=${retained.kind}; written before accept; retained after dismiss.`]
        : []),
      ...(succeeded ? [] : ['  未产生可供 owner 接受的 proposal。']),
    ].join('\n');
  });
  const hasPending = proposals.some((entry) => {
    const output = isRecord(entry.domain_output) ? entry.domain_output : undefined;
    const status = typeof output?.status === 'string' ? output.status : undefined;
    return (
      entry.status === 'succeeded' &&
      status !== undefined &&
      status !== 'failed' &&
      !status.startsWith('skipped:')
    );
  });
  return [
    '<!--copilot-proposal-disclosure:start-->',
    '本轮 proposal 结果由服务端契约裁定：',
    ...rows,
    '- owner gate: FULL',
    '- direct target write: false',
    '- pre-accept rollback: dismiss_before_accept',
    hasPending
      ? '目标变更尚未直接写入；只有 owner 接受对应 proposal 后才会应用。'
      : '本轮没有可接受的 proposal，未执行任何目标变更。',
    '<!--copilot-proposal-disclosure:end-->',
  ].join('\n');
}

function applyProposalDisclosure(text: string, disclosure?: string): string {
  let stripped = text
    .replace(
      /\n*<!--copilot-proposal-disclosure:start-->[\s\S]*?<!--copilot-proposal-disclosure:end-->\s*$/,
      '',
    )
    .trimEnd();
  if (disclosure) {
    stripped = stripped
      .replace(/\bLIGHT\b/g, 'FULL')
      .replace(
        /(?:已|已经)(?:直接)?(?:归档|删除|写入|修改|更新|应用|执行)(?:完成)?/g,
        '目标变更尚未直接写入',
      )
      .replace(
        /(?:无需|不需要)\s*(?:FULL|owner)[^\n。]{0,20}(?:确认|接受|gate)/gi,
        '仍需 owner 通过 FULL gate 接受 proposal',
      );
  }
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

async function resolvePrimaryViewNomination(
  nomination: PresentPrimaryViewInput,
  trace: readonly TraceEntry[],
  resolveArtifactReference: CreateCopilotReplyFinalizerOptions['resolveArtifactReference'],
): Promise<CopilotPrimaryView | undefined> {
  if (nomination.source === 'ephemeral_html') return nomination;
  if (nomination.source === 'tool_result') {
    const observed = trace.find(
      (entry) =>
        entry.root_call &&
        entry.status === 'succeeded' &&
        entry.domain_executed === true &&
        entry.effect !== 'control' &&
        entry.tool_use_id === nomination.ref.id &&
        domainToolName(entry.tool_name) === nomination.ref.kind,
    );
    if (!observed || observed.output_sha256 !== sha256CanonicalJson(observed.domain_output))
      return undefined;
    return {
      ...nomination,
      snapshot: buildCopilotToolResultSnapshot(nomination.ref.kind, observed.domain_output),
    };
  }
  try {
    const ref = await resolveArtifactReference(nomination.ref);
    return ref ? { source: 'artifact', ref } : undefined;
  } catch {
    return undefined;
  }
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
      { type: 'text', text: `tool_use_id=${observation.call.id}` },
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
  ): Promise<CopilotReplyFinalizationResult> {
    if (failure !== undefined) {
      return failClosed(publicProseFailureMessage(providerFailureToPublicFailure(failure)));
    }
    const startVersion = traceVersion;
    const startTraceSha = digestTrace(trace);
    try {
      if (terminalText.length > COPILOT_REPLY_CHAR_LIMIT || terminalText.trim().length === 0) {
        throw new Error('terminal Markdown must be non-empty and within the reply limit');
      }
      if (trace.some((entry) => entry.status === 'in_flight' || entry.output_sha256 === null)) {
        throw new Error('cannot seal an incomplete tool trace');
      }
      const candidateSha = sha256Text(terminalText);
      const presentedText = options.authoritativeReply?.reply ?? terminalText;
      const successfulControls = trace.filter(
        (entry) =>
          entry.root_call &&
          domainToolName(entry.tool_name) === 'present_primary_view' &&
          entry.domain_executed === true &&
          entry.status === 'succeeded',
      );
      const controlOutput = successfulControls.at(-1)?.domain_output;
      // Lifecycle metadata is produced by the control; reject every other extra
      // field, especially a model-supplied snapshot.
      const { presentation_lifecycle: _lifecycle, ...nominationOutput } = isRecord(controlOutput)
        ? controlOutput
        : {};
      const parsedNomination = PresentPrimaryViewOutputSchema.safeParse(nominationOutput);
      const nomination = parsedNomination.success ? parsedNomination.data : undefined;
      const resolvedNomination = nomination
        ? await resolvePrimaryViewNomination(nomination, trace, options.resolveArtifactReference)
        : undefined;
      const presented = {
        text: presentedText,
        ...(resolvedNomination ? { primaryView: resolvedNomination } : {}),
      };
      const correction = resolveCorrectionReply(
        presented.text,
        options.correctionContract,
        stripCopilotInternalComments,
      );
      const disclosure = proposalDisclosure(trace);
      // YUK-1548 — only compose_block may mint tlp-block fences. Neutralise
      // hand-written ones before substitution (render as inert code).
      const withDisclosure = applyProposalDisclosure(correction.reply, disclosure).replace(
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
          return output?.status === 'ready' && typeof output.ref === 'string'
            ? [{ ref: output.ref, block: output.block }]
            : [];
        });
      const blocksByRef = new Map(readyBlocks.map((b) => [b.ref, b.block]));
      const placedRefs = new Set<string>();
      let dropped = 0;
      const withPlaced = withDisclosure.replace(
        BLOCK_PLACE_PATTERN,
        (_match, _alt, ref: string) => {
          if (!blocksByRef.has(ref)) {
            dropped += 1;
            return '';
          }
          placedRefs.add(ref);
          return `\n\n${serializeBlockFence(blocksByRef.get(ref) as never)}\n\n`;
        },
      );
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
      const appendedFences = appended
        .map((b) => serializeBlockFence(b.block as never))
        .join('\n\n');
      const fixed = appendedFences ? `${withPlaced.trimEnd()}\n\n${appendedFences}` : withPlaced;
      const blocksReceipt =
        readyBlocks.length > 0 || dropped > 0
          ? { placed: placedRefs.size, appended: appended.length, dropped, unplaced }
          : undefined;
      if (
        traceVersion !== startVersion ||
        digestTrace(trace) !== startTraceSha ||
        trace.some((entry) => entry.status === 'in_flight')
      ) {
        throw new Error('tool trace changed while reply finalization was in progress');
      }
      const primaryView = presented.primaryView;
      const receipt: CopilotReplyFinalizationReceipt = {
        protocol_version: 2,
        assurance: 'execution_trace_bound',
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: candidateSha,
        reply_sha256: sha256Text(fixed),
        trace_sha256: startTraceSha,
        trace_call_count: trace.length,
        observed_completed_tool_use_ids: observedCompletedToolUseIds(),
        correction: options.authoritativeReply?.correction ?? correction.kind,
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        primary_view:
          successfulControls.length > 0 ? (primaryView ? 'retained' : 'dropped') : 'absent',
        ...(blocksReceipt ? { blocks: blocksReceipt } : {}),
      };
      return {
        replyText: fixed,
        preparedReply: primaryView ? { text: fixed, primaryView } : { text: fixed },
        receipt,
        accepted: true,
      };
    } catch {
      return failClosed();
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

  function failClosed(copy = FINALIZATION_FAILURE_REPLY): CopilotReplyFinalizationResult {
    const disclosure = proposalDisclosure(trace);
    const replyText = applyProposalDisclosure(copy, disclosure);
    const traceSha = digestTrace(trace);
    return {
      replyText,
      preparedReply: { text: replyText },
      accepted: false,
      receipt: {
        protocol_version: 2,
        assurance: 'execution_trace_bound',
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: sha256Text(''),
        reply_sha256: sha256Text(replyText),
        trace_sha256: traceSha,
        trace_call_count: trace.length,
        observed_completed_tool_use_ids: observedCompletedToolUseIds(),
        correction: 'normal',
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        primary_view: 'absent',
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
