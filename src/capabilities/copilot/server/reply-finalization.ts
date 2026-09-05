import { createHash } from 'node:crypto';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type {
  ProposalEffectContract,
  ToolExecutionGateInput,
  ToolExecutionResultObservation,
} from '@/kernel/tools/types';
import { copilotLearningContentRequiresValidation } from './content-validation';
import type { CopilotCorrectionContract } from './correction-contract';
import { resolveCorrectionReply } from './correction-contract';

export const COPILOT_REPLY_TRACE_MAX_CALLS = 60;

const MAX_REPLY_CHARS = 64_000;
const FINALIZATION_FAILURE_REPLY = '这次回复没有完成可验证的收口，暂不展示未封存的草稿。请重试。';

export const CopilotPrimaryViewSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tool_result'),
    ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }),
  }),
  z.object({
    source: z.literal('artifact'),
    ref: z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(120) }),
  }),
  z.object({ source: z.literal('ephemeral_html'), ref: z.string().min(1).max(32_000) }),
]);

export type CopilotPrimaryView = z.infer<typeof CopilotPrimaryViewSchema>;

export const PRIMARY_VIEW_MARKER_START = '<!--primary_view';
const PRIMARY_VIEW_MARKER_RE = /<!--primary_view:([\s\S]*?)-->/g;

export function extractPrimaryView(
  text: string,
  opts: { taskRunId: string },
): { text: string; primaryView?: CopilotPrimaryView } {
  let primaryView: CopilotPrimaryView | undefined;
  let sawMarker = false;
  let sawMalformed = false;
  const tryParse = (jsonText: string): CopilotPrimaryView | undefined => {
    try {
      const parsed = CopilotPrimaryViewSchema.safeParse(JSON.parse(jsonText));
      if (parsed.success) return parsed.data;
    } catch {
      // handled below
    }
    sawMalformed = true;
    return undefined;
  };

  let working = text;
  const lastStart = working.lastIndexOf(PRIMARY_VIEW_MARKER_START);
  if (lastStart !== -1) {
    const tail = working.slice(lastStart).match(/^<!--primary_view:([\s\S]*)-->\s*$/);
    if (tail) {
      sawMarker = true;
      primaryView = tryParse(tail[1] as string);
      working = working.slice(0, lastStart);
    }
  }
  const earlier: CopilotPrimaryView[] = [];
  const stripped = working.replace(PRIMARY_VIEW_MARKER_RE, (_match, jsonText: string) => {
    sawMarker = true;
    const parsed = tryParse(jsonText);
    if (parsed) earlier.push(parsed);
    return '';
  });
  if (!primaryView && earlier.length > 0) primaryView = earlier.at(-1);
  let cleaned = stripped;
  const dangling = cleaned.lastIndexOf(PRIMARY_VIEW_MARKER_START);
  if (dangling !== -1) {
    sawMarker = true;
    sawMalformed = true;
    cleaned = cleaned.slice(0, dangling);
  }
  if (sawMalformed) {
    console.warn('[copilot-reply-finalization] malformed primary_view marker; dropping it', {
      task_run_id: opts.taskRunId,
    });
  }
  cleaned = sawMarker ? cleaned.trimEnd() : cleaned;
  return primaryView ? { text: cleaned, primaryView } : { text: cleaned };
}

export const CopilotReplyFinalizationReceiptSchema = z
  .object({
    protocol_version: z.literal(1),
    assurance: z.literal('root_attested_structural'),
    root_task_run_id: z.string().min(1),
    candidate_sha256: z.string().length(64),
    reply_sha256: z.string().length(64),
    trace_sha256: z.string().length(64),
    trace_call_count: z.number().int().min(0).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    relied_on_tool_use_ids: z.array(z.string().min(1)).max(COPILOT_REPLY_TRACE_MAX_CALLS),
    correction: z.enum(['normal', 'clarify', 'corrected']),
    proposal_disclosure: z.enum(['none', 'server_composed']),
    learning_content: z.enum(['not_applicable', 'passed', 'blocked']),
    primary_view: z.enum(['absent', 'retained', 'dropped']),
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
  proposal_output?: unknown;
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
  userContextText: string;
  /** Deterministic service reply that supersedes model prose for this turn. */
  authoritativeReply?: { reply: string; correction: 'clarify' };
  validateLearningContent: (
    text: string,
    contextText: string,
    taskRunId: string,
    primaryView?: CopilotPrimaryView,
  ) => Promise<{ replyText: string; passed: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function proposalDisclosure(trace: readonly TraceEntry[]): string | undefined {
  const proposals = trace.filter((entry) => entry.proposal_effect_contract !== undefined);
  if (proposals.length === 0) return undefined;
  const rows = proposals.map((entry) => {
    const output = isRecord(entry.proposal_output) ? entry.proposal_output : undefined;
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
    const output = isRecord(entry.proposal_output) ? entry.proposal_output : undefined;
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
  return sha256CanonicalJson(trace.map(({ proposal_output: _output, ...entry }) => entry));
}

export function createCopilotReplyFinalizer(options: CreateCopilotReplyFinalizerOptions) {
  const trace: TraceEntry[] = [];
  const byId = new Map<string, TraceEntry>();
  let traceVersion = 0;

  const preHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    if (trace.length >= COPILOT_REPLY_TRACE_MAX_CALLS) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Copilot turn tool-call ceiling reached',
        },
      };
    }
    const entry: TraceEntry = {
      ordinal: trace.length + 1,
      tool_use_id: input.tool_use_id,
      tool_name: input.tool_name,
      input_sha256: sha256CanonicalJson(input.tool_input),
      output_sha256: null,
      status: 'in_flight',
      effect: null,
      root_call: input.agent_id === undefined,
    };
    trace.push(entry);
    byId.set(entry.tool_use_id, entry);
    traceVersion += 1;
    return { continue: true };
  };

  const postHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') {
      return { continue: true };
    }
    const entry = byId.get(input.tool_use_id);
    if (entry?.status !== 'in_flight') return { continue: true };
    entry.status = input.hook_event_name === 'PostToolUse' ? 'succeeded' : 'failed';
    entry.output_sha256 = sha256CanonicalJson(
      input.hook_event_name === 'PostToolUse' ? input.tool_response : { error: input.error },
    );
    traceVersion += 1;
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: `tool_use_id=${input.tool_use_id}`,
      },
    };
  };

  const hooks: NonNullable<Options['hooks']> = {
    PreToolUse: [{ hooks: [preHook] }],
    PostToolUse: [{ hooks: [postHook] }],
    PostToolUseFailure: [{ hooks: [postHook] }],
  };

  const terminalEnvelope = z
    .object({
      reply_md: z.string().min(1).max(MAX_REPLY_CHARS),
      relied_on_tool_use_ids: z
        .array(z.string().min(1))
        .max(COPILOT_REPLY_TRACE_MAX_CALLS)
        .refine((ids) => new Set(ids).size === ids.length, 'tool use ids must be unique'),
    })
    .strict();

  async function finalizeTerminal(terminalText: string): Promise<CopilotReplyFinalizationResult> {
    const startVersion = traceVersion;
    const startTraceSha = digestTrace(trace);
    try {
      const parsedInput = terminalEnvelope.parse(JSON.parse(terminalText));
      const relied = parsedInput.relied_on_tool_use_ids.map((id) => byId.get(id));
      if (
        relied.some(
          (entry) =>
            !entry?.root_call || entry.status !== 'succeeded' || entry.output_sha256 === null,
        )
      ) {
        throw new Error('relied_on_tool_use_ids must name settled successful current-root calls');
      }
      if (trace.some((entry) => entry.status === 'in_flight')) {
        throw new Error('cannot seal while a tool call is in flight');
      }
      const candidateSha = sha256Text(parsedInput.reply_md);
      const presented = extractPrimaryView(
        options.authoritativeReply?.reply ?? parsedInput.reply_md,
        {
          taskRunId: options.rootTaskRunId,
        },
      );
      const correction = resolveCorrectionReply(presented.text, options.correctionContract);
      const disclosure = proposalDisclosure(trace);
      const disclosed = applyProposalDisclosure(correction.reply, disclosure);
      const requiresLearningValidation =
        copilotLearningContentRequiresValidation(disclosed) ||
        (presented.primaryView?.source === 'ephemeral_html' &&
          copilotLearningContentRequiresValidation(presented.primaryView.ref));
      const learning = await options.validateLearningContent(
        disclosed,
        options.userContextText,
        options.rootTaskRunId,
        presented.primaryView,
      );
      let fixed = applyProposalDisclosure(
        !learning.passed && correction.kind !== 'normal' ? correction.reply : learning.replyText,
        disclosure,
      );
      if (!learning.passed) {
        const fixedReview = await options.validateLearningContent(
          fixed,
          options.userContextText,
          options.rootTaskRunId,
        );
        if (!fixedReview.passed || fixedReview.replyText !== fixed) {
          fixed = applyProposalDisclosure(FINALIZATION_FAILURE_REPLY, disclosure);
        }
      }
      if (
        traceVersion !== startVersion ||
        digestTrace(trace) !== startTraceSha ||
        trace.some((entry) => entry.status === 'in_flight')
      ) {
        throw new Error('tool trace changed while reply validation was in progress');
      }
      const learningBlocked = !learning.passed;
      const primaryView =
        learning.passed && !trace.some((entry) => entry.effect === 'read')
          ? presented.primaryView
          : undefined;
      const receipt: CopilotReplyFinalizationReceipt = {
        protocol_version: 1,
        assurance: 'root_attested_structural',
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: candidateSha,
        reply_sha256: sha256Text(fixed),
        trace_sha256: startTraceSha,
        trace_call_count: trace.length,
        relied_on_tool_use_ids: parsedInput.relied_on_tool_use_ids,
        correction: options.authoritativeReply?.correction ?? correction.kind,
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        learning_content: learningBlocked
          ? 'blocked'
          : requiresLearningValidation
            ? 'passed'
            : 'not_applicable',
        primary_view: presented.primaryView ? (primaryView ? 'retained' : 'dropped') : 'absent',
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
    if (entry?.status !== 'in_flight') return;
    entry.effect = result.effect;
    entry.status = result.error_reason === null ? 'succeeded' : 'failed';
    entry.output_sha256 = sha256CanonicalJson(result.output);
    entry.proposal_effect_contract = result.proposal_effect_contract;
    entry.proposal_output = result.output;
    traceVersion += 1;
  }

  function failClosed(): CopilotReplyFinalizationResult {
    const disclosure = proposalDisclosure(trace);
    const replyText = applyProposalDisclosure(FINALIZATION_FAILURE_REPLY, disclosure);
    const traceSha = digestTrace(trace);
    return {
      replyText,
      preparedReply: { text: replyText },
      accepted: false,
      receipt: {
        protocol_version: 1,
        assurance: 'root_attested_structural',
        root_task_run_id: options.rootTaskRunId,
        candidate_sha256: sha256Text(''),
        reply_sha256: sha256Text(replyText),
        trace_sha256: traceSha,
        trace_call_count: trace.length,
        relied_on_tool_use_ids: [],
        correction: 'normal',
        proposal_disclosure: disclosure ? 'server_composed' : 'none',
        learning_content: 'blocked',
        primary_view: 'absent',
      },
    };
  }

  return {
    hooks,
    beforeDomainTool(_tool: ToolExecutionGateInput): string | undefined {
      return trace.length >= COPILOT_REPLY_TRACE_MAX_CALLS
        ? 'Copilot turn tool-call ceiling reached'
        : undefined;
    },
    observeDomainTool,
    finalizeTerminal,
  };
}

export function prependCopilotFinalizationHooks(
  finalizerHooks: NonNullable<Options['hooks']>,
  existing?: Options['hooks'],
): NonNullable<Options['hooks']> {
  return {
    ...(existing ?? {}),
    PreToolUse: [...(finalizerHooks.PreToolUse ?? []), ...(existing?.PreToolUse ?? [])],
    PostToolUse: [...(finalizerHooks.PostToolUse ?? []), ...(existing?.PostToolUse ?? [])],
    PostToolUseFailure: [
      ...(finalizerHooks.PostToolUseFailure ?? []),
      ...(existing?.PostToolUseFailure ?? []),
    ],
  };
}
