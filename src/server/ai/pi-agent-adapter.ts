// YUK-921 P4 — THE execution adapter (post-SDK-retirement the only one). One
// agentLoop per query; its events are normalized into SDKMessage-shaped
// RunnerMessage frames (see execution-adapter.ts `PiRunnerMessage`) so the
// consume loop keeps one lifecycle implementation.
//
// Engine contract (design §6 R5, all preserved from the SDK lane):
//   - tools surface under the SAME `mcp__<server>__<tool>` wire names, so
//     allowedTools filtering / recordToolCall / shouldEmitToolUseForCaller
//     see identical names;
//   - maxTurns maps to finishTurn — the terminal frame reports the
//     SDK subtype 'error_max_turns';
//   - beforeToolCall composes the piHooks gate chain (deny →
//     {block, reason}, interrupt → terminate); arg-rewriting allows
//     (updatedInput) throw loudly;
//   - toolResult messages become SDK user frames carrying tool_result blocks;
//   - text output only — structured output stays the strict-prompt + Zod
//     text-JSON fallback (the production path on the default mimo lane);
//   - abort = no terminal frame: the lifecycle's `aborted` binding produces
//     the cancellation truth, never a synthesized success.
//
// P3 surfaces (YUK-1022) are the direct caller contracts now:
//   skills      → piSkillDocs: SKILL.md bodies appended to systemPrompt
//   agents      → piAgents: Task/Agent AgentTools + in-process nested loops
//   hooks       → piHooks bridge into beforeToolCall / afterToolCall
//   compaction  → nativeCompaction → transformContext budget-prune + bounded
//                 sessionContext re-injection
//   resume      → options.resume (`pi:` id) + piSessionReplay durable turns
//                 seeded into context.messages (fails closed without replay)
// Steering/follow-up are wired as a ctx surface (`ctx.piQueues` → root-loop
// getSteeringMessages/getFollowUpMessages) with NO live consumer today — the
// surface exists so attaching queue semantics later needs no adapter surgery.
//
// Session/header contract (spike probe 6): every opencode request needs
// `x-opencode-session`; we inject the durable run id (`ai_task_run.id`) — the
// same per-attempt fencing identity the lifecycle already owns.

import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  FinishTurn,
  StreamFn,
  agentLoop as piAgentLoop,
} from '@earendil-works/pi-agent-core';
import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  Model as PiModel,
  MutableModels as PiMutableModels,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';
import type { TaskDefinition } from '@/ai/task-spec';
import { tasks } from '@/capabilities/task-registry';
import { getConfig } from '@/core/config/store';
import { rawArgumentsEvidence } from '@/core/raw-arguments-evidence';
import type {
  ExecutionAdapter,
  ExecutionAdapterStartupArgs,
  PiReplayTurn,
  PiRunnerMessage,
  PreparedExecutionQuery,
  RunnerMessage,
} from './execution-adapter';
import { startTraceSpan, traceOperation, tracePiStream } from './laminar-tracing';
import {
  createPiContextCompactionPolicy,
  createPiLlmMessageConverter,
  estimatePiTokens,
} from './pi-context-policy';
import { emitPiAfterToolCall, runPiBeforeToolCall } from './pi-hooks';
import { type LoomPiModel, createLoomPiModels } from './pi-models';
import { piProviderId } from './pi-provider-catalog';
import { hasPiUsageEvidence, withPiUsageEvidence } from './pi-usage-evidence';
import {
  type ProviderErrorEvidence,
  createProviderErrorCaptureFetch,
  sanitizeArgumentsEvidence,
  sanitizeArgumentsEvidenceText,
} from './provider-error-evidence';
import {
  OPENAI_SDK_DEFAULT_TIMEOUT_MS,
  PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
  providerHttpTimeoutMs,
} from './provider-http-timeout';
import { createBudgetedProviderFetch } from './provider-transport';
import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from './sdk-types';
import { isSpawnToolName } from './spawn-contract';
import {
  STRUCTURED_OUTPUT_SUBMIT_TOOL,
  STRUCTURED_SUBMIT_REMINDER,
  classifySubmitTurn,
  resolveStructuredSubmitPolicy,
  structuredSubmitSystemSuffix,
  structuredSubmitWireFields,
} from './structured-submit';
import {
  type ToolParamCoercion,
  isToolArgumentContractFailure,
  isToolParamContractRejection,
  repairToolArguments,
} from './tool-param-contract';
import {
  type PiSubagentHost,
  type PiSubagentSpec,
  buildPiSpawnAgentTools,
} from './tools/pi-subagent';
import {
  type PiRemoteMcpMountHandle,
  type PiToolMount,
  buildPiDomainAgentTools,
  connectPiRemoteMcp,
  piCustomTool,
} from './tools/pi-tools';

type PiModels = Pick<PiMutableModels, 'getModel' | 'streamSimple'>;
type PiUserContent = Extract<PiMessage, { role: 'user' }>['content'];
type PiToolResultMessage = Extract<PiMessage, { role: 'toolResult' }>;

/** Injectable seams so unit tests can pin behavior without network or mocks. */
export interface PiAdapterDeps {
  models?: PiModels;
  agentLoop?: typeof piAgentLoop;
  /** Test seam for the remote-MCP bridge — production resolves the real client. */
  connectRemoteMcp?: typeof connectPiRemoteMcp;
}

const OPENCODE_SESSION_HEADER = 'x-opencode-session';
const STRUCTURED_OUTPUT_TOOL = STRUCTURED_OUTPUT_SUBMIT_TOOL;

function toolOutputSchema(kind: ExecutionAdapterStartupArgs['kind']) {
  const definition: TaskDefinition = tasks[kind];
  return definition.structuredOutputMode === 'tool' ? definition.structuredOutputSchema : undefined;
}

/**
 * YUK-590 — provider retry cap, preserving the CLAUDE_CODE_MAX_RETRIES env
 * contract the SDK subprocess honoured. Default 2 (three total attempts) keeps
 * short transient absorption while returning control to loom's one deliberate
 * retry layer. An unparseable value falls back to the default, not a throw.
 */
export function piMaxRetries(): number | undefined {
  // YUK-1007：DB > env > code-default(2)。env 层保留原语义（非有限/负 → 默认）。
  const v = getConfig('CLAUDE_CODE_MAX_RETRIES');
  return typeof v === 'number' ? v : 2;
}

/**
 * Pi session ids carry a `pi:` prefix so a persisted `agent_sdk_session_id`
 * cursor is unambiguous. Same-process pi cursors resume verbatim; a
 * cross-process or lane-mismatched attempt cold-starts from the caller's
 * durable-turn replay (copilot-execution computes the caller-side resume),
 * so context-digest delivery gating (`shouldDeliverCopilotSessionContext`)
 * keeps its per-session memory.
 */
export const PI_SESSION_ID_PREFIX = 'pi:';

function piSessionIdFor(optionsResume: string | undefined): string {
  return optionsResume?.startsWith(PI_SESSION_ID_PREFIX)
    ? optionsResume
    : `${PI_SESSION_ID_PREFIX}${randomUUID()}`;
}

/** End at the configured ceiling without turning a clean final answer into failure. */
function turnLimiter(maxTurns: number, onToolLimit: () => void): FinishTurn {
  let completed = 0;
  return ({ message }) => {
    completed += 1;
    // Pi calls finishTurn on failures too. Preserve the provider error/abort truth.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    if (completed < maxTurns) return;
    if (message.content.some((block) => block.type === 'toolCall')) onToolLimit();
    // Also suppress queue polling after a clean final turn at the ceiling.
    return { action: 'end' };
  };
}

const EMPTY_PI_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Replay turns → AgentMessages for `context.messages` seeding. Assistant
 * entries need the model's envelope fields (api/provider/usage/stopReason);
 * `convertToLlm` only reads role+content, so the envelope is honest
 * bookkeeping, not fabricated provider data.
 */
export function piReplayTurnsToMessages(
  turns: readonly PiReplayTurn[],
  model: PiModel<PiApi>,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const turn of turns) {
    if (turn.text.length === 0) continue;
    if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: turn.text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } },
        stopReason: 'stop',
        timestamp: Date.now(),
      } satisfies PiAssistantMessage);
    } else {
      // 'user' and 'context' both land as user-role messages — the same
      // position the pinned header occupies in the cold-start envelope.
      messages.push(piUserMessage(turn.text));
    }
  }
  return messages;
}

/** SDK init-frame equivalent: only `session_id` is consumed downstream. */
function piInitFrame(args: {
  sessionId: string;
  model: PiModel<PiApi>;
  tools: readonly AgentTool[];
}): PiRunnerMessage {
  return {
    source: 'pi',
    type: 'system',
    subtype: 'init',
    agents: [],
    apiKeySource: 'none',
    claude_code_version: 'pi-agent-loop',
    cwd: process.cwd(),
    tools: args.tools.map((tool) => tool.name),
    mcp_servers: [],
    model: args.model.id,
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    uuid: randomUUID(),
    session_id: args.sessionId,
  } as PiRunnerMessage;
}

function piCompactBoundaryFrame(args: {
  sessionId: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
}): PiRunnerMessage {
  return {
    source: 'pi',
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: args.preTokens,
      post_tokens: args.postTokens,
      duration_ms: args.durationMs,
    },
    uuid: randomUUID(),
    session_id: args.sessionId,
  } as PiRunnerMessage;
}

/** task_* frame builders — the shapes subagent-mailbox/subagents.ts consume. */
function piTaskStartedFrame(args: {
  sessionId: string;
  taskId: string;
  toolCallId: string;
  description: string;
  subagentType: string;
  prompt: string;
}): PiRunnerMessage {
  return {
    source: 'pi',
    type: 'system',
    subtype: 'task_started',
    task_id: args.taskId,
    tool_use_id: args.toolCallId,
    description: args.description,
    subagent_type: args.subagentType,
    prompt: args.prompt,
    uuid: randomUUID(),
    session_id: args.sessionId,
  } as PiRunnerMessage;
}

function piTaskProgressFrame(args: {
  sessionId: string;
  taskId: string;
  toolCallId: string;
  description: string;
  subagentType: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName?: string;
}): PiRunnerMessage {
  return {
    source: 'pi',
    type: 'system',
    subtype: 'task_progress',
    task_id: args.taskId,
    tool_use_id: args.toolCallId,
    description: args.description,
    subagent_type: args.subagentType,
    usage: {
      total_tokens: args.totalTokens,
      tool_uses: args.toolUses,
      duration_ms: args.durationMs,
    },
    ...(args.lastToolName ? { last_tool_name: args.lastToolName } : {}),
    uuid: randomUUID(),
    session_id: args.sessionId,
  } as PiRunnerMessage;
}

function piTaskUpdatedFrame(args: {
  sessionId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  error?: string;
}): PiRunnerMessage {
  return {
    source: 'pi',
    type: 'system',
    subtype: 'task_updated',
    task_id: args.taskId,
    patch: {
      status: args.status,
      end_time: Date.now(),
      ...(args.error ? { error: args.error } : {}),
    },
    uuid: randomUUID(),
    session_id: args.sessionId,
  } as PiRunnerMessage;
}

function piUserMessage(content: PiUserContent): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Convert one SDK user message into pi's UserMessage. Text and base64 images
 * map 1:1; url image sources are rejected upstream in runner.ts and tool_result
 * rejected loudly rather than silently dropped into a malformed request.
 */
function sdkUserMessageToPi(msg: SDKUserMessage): AgentMessage {
  const content = msg.message?.content;
  if (content === undefined || typeof content === 'string') {
    return piUserMessage(content ?? '');
  }
  const blocks = content.map((block): Extract<PiUserContent, unknown[]>[number] => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return { type: 'text', text: block.text };
    }
    if (
      block.type === 'image' &&
      typeof block.source === 'object' &&
      block.source !== null &&
      block.source.type === 'base64' &&
      typeof block.source.data === 'string'
    ) {
      return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    }
    throw new Error(
      `pi adapter cannot carry SDK user block '${block.type}' — url images are rejected in runner.ts; tool_result frames are synthesized by the adapter`,
    );
  });
  return piUserMessage(blocks);
}

async function collectPromptMessages(
  prompt: string | AsyncIterable<SDKUserMessage>,
): Promise<AgentMessage[]> {
  if (typeof prompt === 'string') return [piUserMessage(prompt)];
  const messages: AgentMessage[] = [];
  for await (const msg of prompt) {
    messages.push(sdkUserMessageToPi(msg));
  }
  return messages;
}

function piUsageToSdk(usage: PiUsage | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_read_input_tokens: usage?.cacheRead ?? 0,
    cache_creation_input_tokens: usage?.cacheWrite ?? 0,
  };
}

/** pi StopReason → Anthropic-wire stop_reason vocabulary the consumers know. */
function piStopReasonToSdk(
  stopReason: PiAssistantMessage['stopReason'] | undefined,
): 'end_turn' | 'max_tokens' | 'tool_use' | null {
  switch (stopReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'toolUse':
      return 'tool_use';
    default:
      return null;
  }
}

/**
 * Map every pi content block to its Anthropic-wire shape. toolCall → tool_use
 * keeps the tool_call_log recorder's contract even though P1 kinds never
 * declare tools. Unknown/future blocks are dropped (text lane).
 */
function piContentToSdk(content: PiAssistantMessage['content']): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text } as ContentBlock);
    } else if (block.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.thinkingSignature ?? '',
      } as ContentBlock);
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.arguments,
      } as ContentBlock);
    }
  }
  return blocks;
}

/**
 * pi AssistantMessage → SDKAssistantMessage-shaped frame. Every field carries
 * real data (id from responseId, model from responseModel, usage from the pi
 * Usage record); only the Anthropic-message envelope is synthesized.
 */
export function piAssistantToSdkFrame(
  message: PiAssistantMessage,
  sessionId: string,
): PiRunnerMessage {
  const sdkMessage = {
    id: message.responseId ?? randomUUID(),
    type: 'message',
    role: 'assistant',
    model: message.responseModel ?? message.model,
    content: piContentToSdk(message.content),
    stop_reason: piStopReasonToSdk(message.stopReason),
    stop_sequence: null,
    usage: piUsageToSdk(message.usage),
  };
  return {
    source: 'pi',
    type: 'assistant',
    usage_observed: hasPiUsageEvidence(message),
    message: sdkMessage as unknown as SDKAssistantMessage['message'],
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function piUsageToResultUsage(usage: PiUsage | undefined, model: PiModel<PiApi>) {
  return {
    usage: piUsageToSdk(usage),
    // The model entry carries THIS loop's own spend only — nested-child usage
    // is merged in by the caller (piTerminalResultFrame), which would double
    // count if the combined run total were baked in here.
    modelUsage: {
      [model.id]: {
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheReadInputTokens: usage?.cacheRead ?? 0,
        cacheCreationInputTokens: usage?.cacheWrite ?? 0,
        webSearchRequests: 0,
        costUSD: usage?.cost?.total ?? 0,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
      },
    },
  };
}

/**
 * pi ToolResultMessage → SDK user-frame shape. SDK emits `user` messages
 * carrying `tool_result` blocks during tool loops; the pi lane mirrors them
 * so any downstream consumer inspecting the wire sees the same frame
 * sequence. (consumeSdkAttempt today only branches on assistant/result/system
 * — the frames are truthful parity, not a new semantic surface.)
 */
export function piToolResultToSdkFrame(
  message: PiToolResultMessage,
  sessionId: string,
): PiRunnerMessage {
  const content = (Array.isArray(message.content) ? message.content : []).map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    if (block.type === 'image') {
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, data: block.data, media_type: block.mimeType },
      };
    }
    return { type: 'text' as const, text: JSON.stringify(block) };
  });
  const sdkMessage = {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: message.toolCallId,
          content,
          is_error: message.isError ?? false,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
  return { ...sdkMessage, source: 'pi' } as PiRunnerMessage;
}

function lastAssistantMessage(messages: AgentMessage[]): PiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role === 'assistant') return msg as PiAssistantMessage;
  }
  return undefined;
}

function assistantText(message: PiAssistantMessage): string {
  let out = '';
  for (const block of message.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/**
 * Build the terminal result frame for a completed agent_end. Returns undefined
 * when the run was caller-aborted — the absence of a terminal frame is what
 * binds the lifecycle's `aborted` truth (budget timeout / cancellation), the
 * same semantics the SDK lane gets from a killed subprocess.
 */
export function piTerminalResultFrame(args: {
  messages: AgentMessage[];
  model: PiModel<PiApi>;
  sessionId: string;
  durationMs: number;
  numTurns: number;
  aborted: boolean;
  /** Set when finishTurn hit the configured turn ceiling — the pi
   *  equivalent of the SDK's `error_max_turns` terminal subtype. */
  cappedByMaxTurns?: boolean;
  /** Only the opt-in structured task uses tool arguments as its terminal result. */
  structuredOutputTool?: boolean;
  /** Reject pi best-effort JSON salvage: original streamed arguments must parse strictly. */
  invalidStructuredArguments?: boolean;
  /** YUK-1547 — the run's ONE shared landing turn was consumed (by the
   *  missing-submit reminder or by a parameter-contract correction) and the
   *  submit still did not land; the terminal names which consumed it. */
  submitLandingConsumedBy?: 'missing_submit' | 'param_contract';
  /** YUK-1547 (C1) — the submit arguments AFTER the shared parameter-contract
   *  repair was adopted (string-serialized array/object fields). This is what
   *  pi validation and execute saw — the raw streamed bytes stay the failure
   *  evidence record. */
  repairedSubmitArguments?: unknown;
  /** Bounded raw-arguments evidence carried on the structured-failure terminal so
   *  the runner can attach it to the task run's tool_call_log. */
  structuredSubmitEvidence?: {
    tool_name: string;
    raw_arguments: string;
    raw_args_sha256: string;
    truncated: boolean;
  };
  /** YUK-1559 (C6) — bounded, sanitized provider error-body capture from the
   *  query's wrapped fetch. Appended to errors[] on a failed terminal so the
   *  raw non-2xx body (not just pi's formatted errorMessage) reaches
   *  ai_task_runs.error_message and paid_effect.unresolved_reason. */
  providerError?: ProviderErrorEvidence;
  /** YUK-1559 (C6) — the capture's shared sanitize+bound for retained
   *  provider text. Applied to pi's errorMessage (errors[0]): the driver can
   *  embed the full unsanitized body in it, which would otherwise bypass the
   *  evidence body's credential redaction and 4096B cap. */
  sanitizeErrorMessage?: (text: string) => string;
  /** P3 — nested-child usage rolled into the run's terminal evidence, the
   *  same way the SDK result aggregates subagent tokens into modelUsage. */
  childUsage?: PiChildUsage;
}): PiRunnerMessage | undefined {
  const final = lastAssistantMessage(args.messages);
  const base = {
    source: 'pi' as const,
    type: 'result' as const,
    usage_observed:
      args.messages.some(
        (message) =>
          message.role === 'assistant' && hasPiUsageEvidence(message as PiAssistantMessage),
      ) ||
      [
        args.childUsage?.input,
        args.childUsage?.output,
        args.childUsage?.cacheRead,
        args.childUsage?.cacheWrite,
        args.childUsage?.costUsd,
      ].some((value) => value !== undefined && value > 0),
    duration_ms: args.durationMs,
    duration_api_ms: args.durationMs,
    num_turns: Math.max(1, args.numTurns),
    permission_denials: [],
    uuid: randomUUID(),
    session_id: args.sessionId,
  };
  // agent_end contains this invocation's messages (not replay history). Pi usage
  // is per response, so sum every root turn before adding nested-loop spend.
  const usage: PiUsage = { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } };
  for (const message of args.messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      usage[key] += message.usage[key];
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      usage.cost[key] += message.usage.cost[key];
    }
  }
  const child = args.childUsage;
  const costUsd = (usage?.cost?.total ?? 0) + (child?.costUsd ?? 0);
  const usageParts = piUsageToResultUsage(usage, args.model);
  // YUK-1559 (C6) — the captured non-2xx body rides as its own errors[] entry
  // so it survives into error_message / unresolved_reason verbatim; errors[0]
  // stays pi's own formatted message (a display string, not the raw body).
  const providerErrorEntry =
    args.providerError !== undefined
      ? `provider_http_error=${JSON.stringify(args.providerError)}`
      : undefined;
  const errorEntry = args.sanitizeErrorMessage ?? ((text: string) => text);
  if (child && (child.input > 0 || child.output > 0)) {
    usageParts.usage.input_tokens += child.input;
    usageParts.usage.output_tokens += child.output;
    usageParts.usage.cache_read_input_tokens += child.cacheRead;
    usageParts.usage.cache_creation_input_tokens += child.cacheWrite;
    for (const [modelId, entry] of child.byModel) {
      const existing = usageParts.modelUsage[modelId];
      if (existing) {
        existing.inputTokens += entry.inputTokens;
        existing.outputTokens += entry.outputTokens;
        existing.cacheReadInputTokens += entry.cacheReadInputTokens;
        existing.cacheCreationInputTokens += entry.cacheCreationInputTokens;
        existing.costUSD += entry.costUSD;
      } else {
        usageParts.modelUsage[modelId] = entry;
      }
    }
  }

  if (args.aborted || final?.stopReason === 'aborted') {
    if (args.aborted) return undefined;
    // Provider-side abort without our signal is an engine error, not caller
    // cancellation — surface it as a terminal error.
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [
        errorEntry(final?.errorMessage ?? 'pi agent aborted by provider'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (!final) {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: 0,
      errors: [
        errorEntry('pi agent_loop ended without an assistant message'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (args.cappedByMaxTurns) {
    return {
      ...base,
      subtype: 'error_max_turns',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [`pi agent_loop stopped at the configured turn ceiling (${args.numTurns})`],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  if (final.stopReason === 'error') {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [
        errorEntry(final.errorMessage ?? 'pi stream error'),
        ...(providerErrorEntry ? [providerErrorEntry] : []),
      ],
      ...usageParts,
    } as SDKResultMessage & { source: 'pi' };
  }
  let structuredOutput: unknown;
  if (args.structuredOutputTool) {
    const calls = final.content.filter((block) => block.type === 'toolCall');
    const call = calls[0];
    const arguments_ = call?.arguments;
    if (
      args.invalidStructuredArguments ||
      final.stopReason !== 'toolUse' ||
      calls.length !== 1 ||
      call?.name !== STRUCTURED_OUTPUT_TOOL ||
      arguments_ == null
    ) {
      return {
        ...base,
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        total_cost_usd: costUsd,
        ...usageParts,
        // The raw-args digest lands in error_message and unresolved_reason so
        // the truncated tool_call_log evidence can be matched back to this run.
        errors: [
          'structured output requires exactly one non-truncated submit call with strictly valid raw JSON arguments; no text fallback' +
            (args.submitLandingConsumedBy === 'missing_submit'
              ? '; the single landing turn was already consumed by the missing-submit reminder without a submit'
              : args.submitLandingConsumedBy === 'param_contract'
                ? '; the single landing turn was already consumed by the parameter-contract correction without a submit'
                : '') +
            (args.structuredSubmitEvidence
              ? `;raw_args_sha256=${args.structuredSubmitEvidence.raw_args_sha256}`
              : ''),
        ],
        ...(args.structuredSubmitEvidence
          ? { structured_submit_evidence: args.structuredSubmitEvidence }
          : {}),
      } as SDKResultMessage & { source: 'pi' };
    }
    // YUK-1547 — the submit call's arguments ARE the structured output (the
    // task's output schema itself); there is no {result: ...} envelope. When
    // the shared parameter-contract repair was adopted the capability sees
    // the REPAIRED arguments — the same value pi validation and execute
    // accepted — so a string-serialized array/object field reaches the domain
    // schema as its declared type. The raw streamed bytes stay the
    // tool_call_log evidence record (structured_submit_evidence on failure).
    structuredOutput = args.repairedSubmitArguments ?? arguments_;
  }
  return {
    ...base,
    subtype: 'success',
    is_error: false,
    result: assistantText(final),
    stop_reason: piStopReasonToSdk(final.stopReason),
    total_cost_usd: costUsd,
    structured_output: structuredOutput,
    ...usageParts,
  } as SDKResultMessage & { source: 'pi' };
}

/** Aggregated usage from nested child loops, merged into the terminal frame
 *  so the run's cost evidence includes subagent spend (SDK parity — the SDK
 *  result's usage/modelUsage roll nested-agent tokens into the totals). */
interface PiChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  byModel: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUSD: number;
      contextWindow: number;
      maxOutputTokens: number;
    }
  >;
}

function emptyPiChildUsage(): PiChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, byModel: new Map() };
}

/**
 * Prepared pi query: startup holds the resolved model + session identity;
 * `query()` runs ONE agentLoop and yields normalized frames. `close()` aborts
 * the loop — the in-process equivalent of the SDK warm transport teardown.
 *
 * P3 additions (YUK-1022):
 * - `sessionId` is the `pi:`-prefixed durable session marker emitted on every
 *   frame; `options.resume` carrying a `pi:` id reuses it verbatim.
 * - `queuedFrames` is the internal sink for frames produced inside the loop
 *   (subagent task_* lifecycle, compact_boundary) — the generator drains it
 *   before each engine event so ordering matches the SDK wire sequence.
 * - Nested-agent runs execute in-process via `PiSubagentHost` — same abort
 *   lineage, same hook gate chain, child usage aggregated into the terminal.
 */
class PiPreparedQuery implements PreparedExecutionQuery {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly sessionId: string;
  private readonly allTools: AgentTool[];
  private readonly queuedFrames: RunnerMessage[] = [];
  private readonly childUsage = emptyPiChildUsage();
  private readonly executedToolCalls = new Map<string, number>();
  /**
   * YUK-1547/YUK-1559 (C1/C6) — per-call bookkeeping for the shared
   * parameter-contract seam. `pendingCoercions` collects adopted string→JSON
   * repairs per tool name (prepareArguments runs before pi validation, so a
   * call that never reaches execute still lands its `coerced` evidence at
   * tool_execution_end). `pendingArgs` holds each in-flight call's original
   * arguments — captured at tool_execution_start, BEFORE pi's validation
   * normalization can touch them — so a param-contract rejection can persist
   * sanitized ≤4KiB raw-args evidence keyed to the exact call.
   */
  private readonly pendingCoercions = new Map<string, ToolParamCoercion[][]>();
  private readonly pendingArgs = new Map<string, { toolName: string; args: unknown }>();
  /** Latest adopted repair per tool name — the structured-submit terminal
   *  hands the capability what validation actually accepted. */
  private readonly repairedToolArgs = new Map<string, unknown>();
  /**
   * YUK-1547 (C1) — ONE run-scoped parameter-contract correction allowance,
   * shared by this query's root loop AND every nested child loop (spawned
   * researchers inherit wrapped tools but have no submit landing machine).
   * A `[tool_param_contract]` rejection may continue once; a second rejection
   * ends the loop regardless of the caller's iteration ceiling — unbounded
   * Copilot and maxTurns runs share this budget. On the structured-submit
   * lane the same allowance is further shared with the missing-submit
   * reminder via `landingTurnUsed`.
   */
  private paramContractCorrectionUsed = false;
  private providerHttp: { fetch: typeof fetch; close: () => Promise<void> } | undefined;

  /**
   * Per-loop streamed-arguments tracker: `rawByIndex` accumulates this turn's
   * `toolcall_delta` bytes; `byCallId` binds them to call ids at message_end.
   * Each agentLoop (root and each nested child) owns its own pair so a
   * child's turn_start can never erase a parent's in-flight evidence.
   */
  private trackStreamedArgs(
    event: AgentEvent,
    rawByIndex: Map<number, string>,
    byCallId: Map<string, string>,
  ): void {
    if (event.type === 'turn_start') {
      rawByIndex.clear();
      byCallId.clear();
      return;
    }
    if (
      event.type === 'message_update' &&
      event.message.role === 'assistant' &&
      event.assistantMessageEvent.type === 'toolcall_delta'
    ) {
      const delta = event.assistantMessageEvent;
      rawByIndex.set(delta.contentIndex, (rawByIndex.get(delta.contentIndex) ?? '') + delta.delta);
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      event.message.content.forEach((block, index) => {
        if (block.type !== 'toolCall') return;
        const raw = rawByIndex.get(index);
        if (raw !== undefined) byCallId.set(block.id, raw);
      });
    }
  }
  /** YUK-1559 (C6) — per-query non-2xx capture fetch; created lazily in
   *  baseLoopConfig once the base fetch (idle-budget or global) is resolved. */
  private providerErrorCapture: ReturnType<typeof createProviderErrorCaptureFetch> | undefined;

  constructor(
    private readonly args: ExecutionAdapterStartupArgs,
    private readonly model: LoomPiModel,
    private readonly deps: Required<PiAdapterDeps>,
    tools: AgentTool[],
    private readonly remoteMcpHandles: PiRemoteMcpMountHandle[],
  ) {
    this.externalSignal = args.options.abortController?.signal;
    if (this.externalSignal?.aborted) {
      this.abort.abort();
    } else {
      this.externalSignal?.addEventListener('abort', () => this.abort.abort(), { once: true });
    }
    this.sessionId = piSessionIdFor(
      typeof args.options.resume === 'string' ? args.options.resume : undefined,
    );
    // The spawn tools are mounted here (not in buildTools) because the host
    // binds to this query's frame sink + abort lineage. They honor the same
    // effective allowedTools filter the domain mounts already passed through —
    // `Task` must be allowlisted exactly as on the SDK lane.
    const allowed = Array.isArray(args.options.tools)
      ? new Set(args.options.tools as string[])
      : undefined;
    const spawnTools =
      args.piAgents && Object.keys(args.piAgents).length > 0
        ? buildPiSpawnAgentTools(args.piAgents, this.subagentHost)
        : [];
    const visibleSpawn =
      allowed === undefined ? spawnTools : spawnTools.filter((tool) => allowed.has(tool.name));
    this.allTools = [...tools, ...visibleSpawn].map((tool) => ({
      ...tool,
      // YUK-1547/YUK-1559 (C1) — EVERY mounted tool gets the shared
      // parameter-contract repair ahead of pi's validateToolArguments (pi
      // calls prepareArguments first — this is the only seam that can fix a
      // string-serialized array/object field before validation rejects the
      // call). A repair that fails throws ToolParamContractError → isError
      // result; execute is never reached, so tool side effects stay
      // exactly-once. Adopted repairs are queued for the persisted `coerced`
      // event drained at tool_execution_end.
      prepareArguments: (rawArgs: unknown) => {
        const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
        const repaired = repairToolArguments(tool.parameters, prepared);
        if (repaired.coercions.length > 0) {
          this.repairedToolArgs.set(tool.name, repaired.args);
          const queue = this.pendingCoercions.get(tool.name) ?? [];
          queue.push(repaired.coercions);
          this.pendingCoercions.set(tool.name, queue);
        }
        return repaired.args;
      },
      execute: (...args: Parameters<AgentTool['execute']>) => {
        this.executedToolCalls.set(args[0], (this.executedToolCalls.get(args[0]) ?? 0) + 1);
        return traceOperation(
          'tool.execute',
          {
            task_run_id: this.args.runId,
            tool_name: tool.name,
            tool_call_id: args[0],
            executed: true,
          },
          () => tool.execute(...args),
          {
            signal: args[2],
            outcome: (result) => (result.isError ? 'error' : 'success'),
            transcript: { input: () => args[1], output: (result) => result },
          },
        );
      },
    }));
  }

  private observeToolAttempt(
    event: AgentEvent,
    streamedArgsByCallId: ReadonlyMap<string, string>,
  ): void {
    if (event.type === 'tool_execution_start') {
      // Capture the model's original arguments BEFORE prepareArguments repair
      // and pi validation normalization — the C6 evidence baseline. Sanitized
      // and bounded only if the call actually fails at the contract seam.
      this.pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      return;
    }
    if (event.type !== 'tool_execution_end') return;
    const executions = this.executedToolCalls.get(event.toolCallId) ?? 0;
    if (executions > 0) {
      if (executions === 1) this.executedToolCalls.delete(event.toolCallId);
      else this.executedToolCalls.set(event.toolCallId, executions - 1);
    }
    const pending = this.pendingArgs.get(event.toolCallId);
    this.pendingArgs.delete(event.toolCallId);
    // Drain adopted string→JSON repairs for this call: the persisted `coerced`
    // event carries tool/field metadata only — never the payload.
    const coercedFields = this.pendingCoercions.get(event.toolName)?.shift();
    if (coercedFields && this.pendingCoercions.get(event.toolName)?.length === 0) {
      this.pendingCoercions.delete(event.toolName);
    }
    if (coercedFields && coercedFields.length > 0) {
      this.emitFrame({
        source: 'pi',
        type: 'system',
        subtype: 'tool_args_coerced',
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        fields: coercedFields,
        uuid: randomUUID(),
        session_id: this.sessionId,
      });
    }
    if (executions > 0) return;
    // YUK-1559 (C6) — a call that failed at the argument-contract seam (our
    // parameter-contract rejection or pi's schema validation) never reached
    // execute: persist the sanitized ≤4KiB original arguments as run evidence.
    // Unknown-tool / hook-blocked / aborted / truncated calls keep their
    // existing (non-args) evidence story.
    if (
      pending !== undefined &&
      isToolArgumentContractFailure({ isError: event.isError, content: event.result?.content })
    ) {
      const secrets = this.args.resolved.apiKey ? [this.args.resolved.apiKey] : [];
      // Fidelity: prefer THIS call's exact streamed argument bytes (sanitized
      // — the recursive pass redacts credential keys even inside embedded
      // JSON string fields before any serialization/cap). When the stream
      // never delivered deltas, event.args is a pi-parsed/salvaged object —
      // label it 'reconstructed' rather than claiming wire fidelity.
      const streamed = streamedArgsByCallId.get(event.toolCallId);
      const args_source = streamed !== undefined ? 'streamed' : 'reconstructed';
      const sanitizedText =
        streamed !== undefined
          ? sanitizeArgumentsEvidenceText(streamed, { secrets })
          : JSON.stringify(sanitizeArgumentsEvidence(pending.args ?? null, { secrets }));
      this.emitFrame({
        source: 'pi',
        type: 'system',
        subtype: 'tool_args_contract_failed',
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        args_source,
        ...rawArgumentsEvidence(sanitizedText),
        uuid: randomUUID(),
        session_id: this.sessionId,
      });
    }
    // Pi emits start/end even for validation, missing-tool and hook-blocked calls.
    // None crossed AgentTool.execute; do not label them executed or copy errors/args.
    const span = startTraceSpan('tool.attempt', {
      task_run_id: this.args.runId,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      executed: false,
    });
    span.transcript('input', () => ({
      arguments: '[omitted: arguments unavailable on terminal event]',
    }));
    span.transcript('output', () => event.result);
    span.end(this.abort.signal.aborted ? 'cancelled' : event.isError ? 'error' : 'success');
  }

  private emitFrame(frame: RunnerMessage): void {
    this.queuedFrames.push(frame);
  }

  /** Drain frames produced inside the loop (subagent lifecycle, compaction). */
  private *drainFrames(): Generator<RunnerMessage> {
    while (this.queuedFrames.length > 0) {
      const frame = this.queuedFrames.shift();
      if (frame !== undefined) yield frame;
    }
  }

  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage> {
    if (this.closed) {
      throw new Error('pi prepared query closed before prompt submission');
    }
    return this.iterate(collectPromptMessages(prompt));
  }

  /**
   * The composed beforeToolCall gate for one loop level. Caller-declared
   * piHooks gates (spawn-contract / cancellation / finalization) run in
   * declaration order with first-defined-result short-circuit. `agentType`
   * marks nested calls (reply-finalization marks `root_call` off it).
   */
  private makeBeforeToolCall(agentType?: string): AgentLoopConfig['beforeToolCall'] {
    const piHooks = this.args.piHooks;
    if (!piHooks?.beforeToolCall?.length) return undefined;
    return async ({ toolCall, args: callArgs }: BeforeToolCallContext, signal) => {
      const effectiveSignal = signal ?? this.abort.signal;
      return runPiBeforeToolCall(
        piHooks,
        { id: toolCall.id, name: toolCall.name, ...(agentType ? { agentType } : {}) },
        (callArgs ?? {}) as Record<string, unknown>,
        effectiveSignal,
      );
    };
  }

  /**
   * The pi `afterToolCall` config — the PostToolUse/PostToolUseFailure
   * equivalent. Observers fire in declaration order; the bridge returns the
   * merged override (the `additionalContext` equivalent — reply-finalization
   * uses it to append `tool_use_id=` context the model sees), so the loop
   * applies the field-wise merge to the settled result.
   */
  private makeAfterToolCall(agentType?: string): AgentLoopConfig['afterToolCall'] {
    const piHooks = this.args.piHooks;
    if (!piHooks?.afterToolCall?.length) return undefined;
    return async ({ toolCall, args: callArgs, result, isError }, signal) => {
      const effectiveSignal = signal ?? this.abort.signal;
      return emitPiAfterToolCall(
        piHooks,
        {
          call: { id: toolCall.id, name: toolCall.name, ...(agentType ? { agentType } : {}) },
          args: (callArgs ?? {}) as Record<string, unknown>,
          isError,
          output: result.content,
          ...(isError ? { error: result.content } : {}),
          // SDK PostToolUseFailure carries is_interrupt — the abort lineage
          // being live at settle time is the pi equivalent.
          ...(effectiveSignal.aborted ? { interrupted: true } : {}),
        },
        effectiveSignal,
      );
    };
  }

  /**
   * ADR-0060 compaction on the pi lane: `transformContext` runs before every
   * LLM call. When the estimated context crosses the window trigger we drop
   * the oldest messages down to the target, re-inject the bounded
   * sessionContext (the SessionStart-compact hook's `additionalContext`
   * equivalent), and emit a compact_boundary frame through the frame queue so
   * `sdk-terminal`'s usage evidence stays identical. Contract: never throws —
   * on any failure the original messages pass through.
   */
  private makeTransformContext(): AgentLoopConfig['transformContext'] {
    const compaction = this.args.nativeCompaction;
    if (!compaction) return undefined;
    const sessionId = this.sessionId;
    const sessionContext = compaction.sessionContext;
    const planCompaction = createPiContextCompactionPolicy(this.model, sessionContext);

    return async (messages) => {
      try {
        const plan = planCompaction(messages);
        if (!plan) return messages;
        const startedAt = Date.now();
        // Keep the newest tail that fits the target; the current-turn prompt
        // is the last element and is never dropped.
        // Pi 1.0 carries instructions and tool declarations in system messages.
        // Replay their deltas before pruning so neither can disappear with history.
        const { getCurrentSystemMessage } = await import('@earendil-works/pi-ai');
        const system = getCurrentSystemMessage(messages);
        const transformed = plan.selectMessages(system, piUserMessage);
        this.emitFrame(
          piCompactBoundaryFrame({
            sessionId,
            preTokens: plan.preTokens,
            postTokens: estimatePiTokens(transformed),
            durationMs: Date.now() - startedAt,
          }),
        );
        return transformed;
      } catch (error) {
        console.warn('[pi-adapter] transformContext failed; passing context through', {
          error: error instanceof Error ? error.message : String(error),
        });
        return messages;
      }
    };
  }

  /**
   * YUK-1630 — every provider request in this query runs through the
   * attempt's controlled transport: an npm-undici Agent whose connect,
   * headers and body timers all take the same budget-derived value the SDK
   * gets as its per-request `timeout` (provider-transport.ts). The runner
   * always resolves `options.providerTimeoutMs` from the task budget; a
   * caller that leaves it unset gets the SDK's 10-minute default as the
   * derivation base so the undici layer stays consistent with the SDK's own
   * bound rather than falling back to hidden undici defaults.
   */
  private providerTransport(): { timeoutMs?: number; fetch: typeof fetch } {
    const timeoutMs = this.args.options.providerTimeoutMs;
    const collector = this.args.options.transportEvidence;
    this.providerHttp ??= createBudgetedProviderFetch({
      httpTimeoutMs: timeoutMs ?? providerHttpTimeoutMs(OPENAI_SDK_DEFAULT_TIMEOUT_MS),
      marginMs: PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
      secrets: this.args.resolved.apiKey ? [this.args.resolved.apiKey] : [],
      ...(collector !== undefined ? { collector } : {}),
    });
    collector?.noteSdkTimeout(
      timeoutMs !== undefined
        ? { sdkTimeoutMs: timeoutMs, source: 'task_budget' }
        : { sdkTimeoutMs: OPENAI_SDK_DEFAULT_TIMEOUT_MS, source: 'sdk_default' },
    );
    return {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      fetch: this.providerHttp.fetch,
    };
  }

  /** Shared config fields every loop level (root + nested) reuses. */
  private baseLoopConfig(): Pick<
    AgentLoopConfig,
    'convertToLlm' | 'headers' | 'apiKey' | 'reasoning' | 'timeoutMs' | 'fetch'
  > {
    const { options, resolved, runId } = this.args;
    const http = this.providerTransport();
    // YUK-1559 (C6) — every provider request in this query funnels through a
    // capture fetch so a non-2xx leaves a bounded, sanitized body + status +
    // request id for the terminal error evidence. A transparent passthrough:
    // it only reads a clone of failing responses. Every loom-registered
    // provider accepts a custom fetch (the same surface providerTransport
    // already uses for the budget-derived dispatcher).
    this.providerErrorCapture ??= createProviderErrorCaptureFetch(
      http.fetch,
      // The request's resolved credential — verbatim + JSON-escaped forms are
      // redacted at the shared boundary before any field/header patterns run.
      { secrets: resolved.apiKey ? [resolved.apiKey] : [] },
    );
    return {
      // All prompts are standard LLM messages — identity conversion narrowed
      // to the LLM roles the union type needs. UI-only AgentMessages never
      // reach this lane (loom owns the durable transcript).
      convertToLlm: createPiLlmMessageConverter(),
      // The x-opencode-session header is an opencode-go wire requirement
      // (400 MissingSessionID without it). Scope it to that lane: forwarding a
      // stray opencode-namespaced header to api.openai.com / the anthropic
      // compat endpoints serves no purpose (YUK-1027).
      ...(resolved.provider === 'opencode-go'
        ? { headers: { [OPENCODE_SESSION_HEADER]: runId } }
        : {}),
      // Per-request credential from the lifecycle-resolved binding — resolved
      // once in resolveTaskProvider for both auth modes (oauth carries the
      // sk-ant-oat* token; the anthropic-messages driver switches to Bearer).
      apiKey: resolved.apiKey,
      // YUK-590 parity: the SDK lane honoured CLAUDE_CODE_MAX_RETRIES to cap
      // provider retries at 2 (three total requests) so a persistent 5xx
      // returns control to loom's deliberate retry layer instead of burning
      // the task budget on client-side retries. Same knob on pi's stream
      // options; preserve an explicit operator value including '0'.
      ...(options.judgeRetryPolicy === 'none'
        ? { maxRetries: 0 }
        : piMaxRetries() !== undefined
          ? { maxRetries: piMaxRetries() }
          : {}),
      ...(options.effort !== undefined ? { reasoning: options.effort } : {}),
      ...(http.timeoutMs !== undefined ? { timeoutMs: http.timeoutMs } : {}),
      fetch: this.providerErrorCapture.fetch,
    };
  }

  /**
   * YUK-1547 — the submit wire policy for this query's resolved lane, read
   * through the shared capability surface (structured-submit.ts). 'forced'
   * pins the named tool_choice; a lane whose profile records the forced
   * choice as wire-rejected (forcedToolChoice:false) degrades to 'auto' +
   * the single closing reminder wired in iterate().
   */
  private structuredSubmitPolicy(model: PiModel<PiApi>) {
    if (toolOutputSchema(this.args.kind) === undefined || model.api !== 'openai-completions') {
      return undefined;
    }
    return resolveStructuredSubmitPolicy(this.args.resolved.provider, this.args.resolved.model);
  }

  private readonly streamFn: StreamFn = (model: LoomPiModel, llmContext, streamOptions) => {
    const effort = streamOptions?.reasoning;
    const inputTokens = estimatePiTokens(llmContext.messages);
    const remaining = model.contextWindow - inputTokens;
    streamOptions = {
      ...streamOptions,
      maxTokens: Math.min(streamOptions?.maxTokens ?? model.maxTokens, model.maxTokens, remaining),
    };
    const submitPolicy = this.structuredSubmitPolicy(model);
    // YUK-1547 — per-task model-native reasoning params (resolved +
    // fail-closed-validated in resolveTaskProvider): pass the model's own
    // wire parameter (e.g. DeepSeek `reasoning_effort`) through verbatim.
    // This is NOT the options.effort → pi ThinkingLevel enum path — startup
    // rejects both being set so the param has exactly one writer.
    const nativeReasoning = this.args.resolved.nativeReasoningParams;
    const streamOptionsWithPayload = {
      ...streamOptions,
      onPayload: async (payload: unknown, requestModel: PiModel<PiApi>) => {
        // Pi converts onPayload failures into terminal errors; throwing from streamFn crashes its loop.
        if (
          effort !== undefined &&
          model.catalogReasoning &&
          !model.catalogReasoning.supportedEfforts.includes(effort)
        ) {
          throw new Error(
            `Model '${model.provider}/${model.id}' does not declare reasoning effort '${effort}' in the runtime catalog`,
          );
        }
        if (inputTokens > (model.maxInputTokens ?? model.contextWindow) || remaining <= 0) {
          throw new Error(
            `Model '${model.provider}/${model.id}' input exceeds its catalog token limit`,
          );
        }
        const transformed = await streamOptions?.onPayload?.(payload, requestModel);
        const body = transformed ?? payload;
        if (submitPolicy === undefined && !nativeReasoning) return body;
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('structured output requires an object provider payload');
        }
        return {
          ...body,
          ...(submitPolicy !== undefined ? structuredSubmitWireFields(submitPolicy) : {}),
          ...nativeReasoning,
        };
      },
    };
    return tracePiStream(
      (m, context, options) =>
        withPiUsageEvidence(
          (innerModel, innerContext, innerOptions) =>
            this.deps.models.streamSimple(innerModel, innerContext, innerOptions),
          m,
          context,
          options,
        ),
      model,
      llmContext,
      streamOptionsWithPayload,
    );
  };

  /**
   * YUK-1547 (C1) — the run-scoped parameter-contract correction gate applied
   * to EVERY loop this query runs (root and nested children share
   * `paramContractCorrectionUsed`). A `[tool_param_contract]` isError result
   * is the correction prompt itself: it may continue ONCE so the model can
   * re-issue the call; a second rejection ends the loop regardless of the
   * caller's iteration ceiling — unbounded Copilot and maxTurns runs share
   * this budget. Clean turns and ordinary valid iterations defer to `inner`.
   */
  private contractCorrectionFinishTurn(inner?: FinishTurn): FinishTurn {
    return (turn, signal) => {
      if (turn.toolResults.some((result) => isToolParamContractRejection(result))) {
        if (this.paramContractCorrectionUsed) return { action: 'end' as const };
        this.paramContractCorrectionUsed = true;
      }
      return inner?.(turn, signal);
    };
  }

  /**
   * Child tool set: the spec's allowlist over the parent's mounted wire names,
   * minus disallowedTools, minus spawn aliases (depth-one is structural — a
   * child can never see Task/Agent even if its def listed them).
   */
  private childToolsFor(spec: PiSubagentSpec): AgentTool[] {
    const parentTools = this.allTools.filter((tool) => !isSpawnToolName(tool.name));
    const allowlisted =
      spec.tools === undefined
        ? parentTools
        : parentTools.filter((tool) => spec.tools?.includes(tool.name));
    const disallowed = new Set(spec.disallowedTools ?? []);
    return allowlisted.filter((tool) => !disallowed.has(tool.name));
  }

  /**
   * Nested-run host for the Task/Agent spawn tools. Runs ONE child agentLoop
   * under the parent's abort lineage and emits the task_started/task_progress/
   * task_updated frames the durable projection consumes. The child's final
   * assistant text is the tool result; failures throw → error tool result
   * (the SDK Task-call parity).
   */
  private readonly subagentHost: PiSubagentHost = {
    runNested: async ({ toolCallId, subagentType, description, prompt, spec, signal }) =>
      traceOperation(
        'agent.child',
        {
          task_run_id: this.args.runId,
          tool_call_id: toolCallId,
          additive_usage: false,
        },
        async () => {
          const taskId = toolCallId;
          const startedAt = Date.now();
          this.emitFrame(
            piTaskStartedFrame({
              sessionId: this.sessionId,
              taskId,
              toolCallId,
              description,
              subagentType,
              prompt,
            }),
          );
          const childModel = this.childModelFor(spec);
          const childTools = this.childToolsFor(spec);
          const childSignal = signal
            ? AbortSignal.any([this.abort.signal, signal])
            : this.abort.signal;
          const childContext: AgentContext = {
            messages: [{ role: 'system', content: spec.prompt, timestamp: Date.now() }],
            ...(childTools.length > 0 ? { tools: childTools } : {}),
          };
          const childMaxTurns = spec.maxTurns;
          let childCapped = false;
          let toolUses = 0;
          let totalTokens = 0;
          let lastToolName: string | undefined;
          const childConfig: AgentLoopConfig = {
            model: childModel,
            ...this.baseLoopConfig(),
            ...(childTools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
            finishTurn: this.contractCorrectionFinishTurn(
              childMaxTurns !== undefined
                ? turnLimiter(childMaxTurns, () => {
                    childCapped = true;
                  })
                : undefined,
            ),
            beforeToolCall: this.makeBeforeToolCall(subagentType),
            afterToolCall: this.makeAfterToolCall(subagentType),
          };

          const accumulate = (message: PiAssistantMessage) => {
            const usage = message.usage;
            if (!usage) return;
            totalTokens += usage.totalTokens;
            this.childUsage.input += usage.input;
            this.childUsage.output += usage.output;
            this.childUsage.cacheRead += usage.cacheRead;
            this.childUsage.cacheWrite += usage.cacheWrite;
            this.childUsage.costUsd += usage.cost.total;
            const entry = this.childUsage.byModel.get(childModel.id) ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0,
              contextWindow: childModel.contextWindow,
              maxOutputTokens: childModel.maxTokens,
            };
            entry.inputTokens += usage.input;
            entry.outputTokens += usage.output;
            entry.cacheReadInputTokens += usage.cacheRead;
            entry.cacheCreationInputTokens += usage.cacheWrite;
            entry.costUSD += usage.cost.total;
            this.childUsage.byModel.set(childModel.id, entry);
          };

          let finalMessages: AgentMessage[] = [];
          const childRawArgs = new Map<number, string>();
          const childStreamedArgs = new Map<string, string>();
          try {
            const stream = this.deps.agentLoop(
              [piUserMessage(prompt)],
              childContext,
              childConfig,
              childSignal,
              this.streamFn,
            );
            for await (const event of stream) {
              this.trackStreamedArgs(event, childRawArgs, childStreamedArgs);
              this.observeToolAttempt(event, childStreamedArgs);
              if (event.type === 'tool_execution_start') {
                toolUses += 1;
                lastToolName = event.toolName;
                continue;
              }
              if (event.type === 'message_end' && event.message.role === 'assistant') {
                const assistant = event.message as PiAssistantMessage;
                accumulate(assistant);
                this.emitFrame(
                  piTaskProgressFrame({
                    sessionId: this.sessionId,
                    taskId,
                    toolCallId,
                    description,
                    subagentType,
                    totalTokens,
                    toolUses,
                    durationMs: Date.now() - startedAt,
                    ...(lastToolName ? { lastToolName } : {}),
                  }),
                );
                continue;
              }
              if (event.type === 'agent_end') {
                finalMessages = event.messages;
              }
            }
            if (childSignal.aborted || this.abort.signal.aborted) {
              throw new Error('nested subagent aborted');
            }
            const final = lastAssistantMessage(finalMessages);
            // Root-loop terminal parity: no assistant at all, a capped turn
            // ceiling, or a provider-side error/aborted stop all mean the child
            // FAILED — a completed task_* row would let the parent answer from
            // a report that does not exist.
            if (!final) {
              throw new Error(
                `nested subagent '${subagentType}' ended without an assistant message`,
              );
            }
            if (childCapped) {
              throw new Error(
                `nested subagent '${subagentType}' stopped at the configured turn ceiling (${childMaxTurns})`,
              );
            }
            if (final.stopReason === 'error' || final.stopReason === 'aborted') {
              throw new Error(
                final.errorMessage ??
                  `nested subagent '${subagentType}' ended with stopReason='${final.stopReason}'`,
              );
            }
            const text = assistantText(final);
            this.emitFrame(
              piTaskUpdatedFrame({
                sessionId: this.sessionId,
                taskId,
                status: 'completed',
              }),
            );
            return text.length > 0 ? text : '(subagent ended without a text report)';
          } catch (error) {
            // An aborted child may either end its stream quietly (handled above)
            // or throw the abort — both must still close the durable task_* row.
            if (childSignal.aborted || this.abort.signal.aborted) {
              this.emitFrame(
                piTaskUpdatedFrame({ sessionId: this.sessionId, taskId, status: 'killed' }),
              );
            } else {
              this.emitFrame(
                piTaskUpdatedFrame({
                  sessionId: this.sessionId,
                  taskId,
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
            throw error;
          }
        },
        { signal: signal ?? this.abort.signal },
      ),
  };

  /** Resolve a spec.model override: 'inherit'/unset → parent model; a pi
   *  catalog id resolves under the run's provider; anything else (SDK alias
   *  names like 'sonnet') fails closed. */
  private childModelFor(spec: PiSubagentSpec): PiModel<PiApi> {
    const declared = spec.model;
    if (declared === undefined || declared === 'inherit') return this.model;
    const resolved = this.deps.models.getModel(piProviderId(this.args.resolved.provider), declared);
    if (!resolved) {
      throw new Error(
        `pi adapter cannot resolve nested-agent model '${declared}' in provider '${this.args.resolved.provider}' — declare a pi catalog id or 'inherit' (SDK alias names are not portable).`,
      );
    }
    return resolved;
  }

  private async *iterate(promptsPromise: Promise<AgentMessage[]>): AsyncGenerator<RunnerMessage> {
    const { options } = this.args;
    const prompts = await promptsPromise;
    let systemPrompt =
      typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : (() => {
            throw new Error(
              'pi adapter requires a plain string systemPrompt (claude_code presets are SDK-only)',
            );
          })();
    // Skill dual-descriptor: SDK injects SKILL.md bodies through its
    // filesystem mirror; the pi lane appends the resolved bodies to the
    // system prompt (same model-visible contract, no Skill tool needed).
    if (this.args.piSkillDocs && this.args.piSkillDocs.length > 0) {
      const docs = this.args.piSkillDocs
        .map((doc) => `<skill name="${doc.name}">\n${doc.body}\n</skill>`)
        .join('\n\n');
      systemPrompt = `${systemPrompt}\n\n${docs}`;
    }
    const structuredOutput = toolOutputSchema(this.args.kind) !== undefined;
    // YUK-1547 — capability-driven submit policy: forced named tool_choice on
    // lanes that accept it; 'auto' + the closing reminder (C2-landing shape)
    // where the provider rejects forcing (forcedToolChoice:false). Both share
    // ONE landing budget with the parameter-contract correction turn.
    const submitPolicy = structuredOutput ? this.structuredSubmitPolicy(this.model) : undefined;
    const submitReminderAllowed = submitPolicy !== undefined && !submitPolicy.forced;
    // YUK-1547 (C1) — ONE landing budget per run, shared across the
    // missing-submit reminder and the parameter-contract correction (not one
    // each). Whichever consumes it first ends the run's extra-turn allowance.
    let landingTurnUsed = false;
    let landingConsumer: 'missing_submit' | 'param_contract' | undefined;
    if (structuredOutput) {
      systemPrompt += structuredSubmitSystemSuffix(submitPolicy?.forced ?? true);
    }
    const context: AgentContext = {
      // sdkSession→本地回放: durable-turn replay seeds context.messages — the
      // pi equivalent of reattaching an SDK session file.
      messages: [
        { role: 'system', content: systemPrompt, timestamp: Date.now() },
        ...piReplayTurnsToMessages(this.args.piSessionReplay ?? [], this.model),
      ],
      ...(this.allTools.length > 0 ? { tools: this.allTools } : {}),
    };
    // options.maxTurns is the runner's agentic-turn ceiling. Pi has no built-in
    // equivalent — finishTurn counts completed turns and asks the
    // loop to end; the terminal frame then reports the normalized subtype
    // 'error_max_turns' so lifecycle/finish-reason handling stays identical.
    // YUK-1026 — SDK parity: the ceiling only bites when the agent wants
    // ANOTHER turn. A turn whose assistant message carries no tool calls ends
    // the loop successfully; the ceiling also leaves queued follow-ups undrained.
    // It must report
    // success, not error_max_turns — under the unconditional counter every
    // maxTurns=1 task deterministically failed after its first clean turn.
    const maxTurns = typeof options.maxTurns === 'number' ? options.maxTurns : undefined;
    let cappedByMaxTurns = false;
    // Per-turn streamed-argument evidence, bound to call ids at message_end;
    // the strict-JSON flag also gates the parameter-contract correction below.
    const rawToolArguments = new Map<number, string>();
    const streamedArgsByCallId = new Map<string, string>();
    let invalidStructuredArguments = false;
    // pi's producer only enqueues events; it does not wait for this adapter's
    // consumer. Gate scheduling on observation of the SAME assistant message
    // (pi emits and passes the same object to finishTurn), never a default flag.
    // Root-local state cannot be acknowledged by a nested loop's events.
    let observedStructuredMessage: PiAssistantMessage | undefined;
    let acknowledgeStructuredMessage: ((message: PiAssistantMessage) => void) | undefined;
    const config: AgentLoopConfig = {
      model: this.model,
      ...this.baseLoopConfig(),
      // SDK in-process MCP tools run serially — pin the same execution mode
      // so batch ordering/tool_call_log sequence can't diverge by engine.
      ...(this.allTools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
      ...(structuredOutput
        ? {
            // Bounded submit state machine (structured-submit.ts): 'landed' or
            // any non-clean turn ends the run — a turn with tool calls that is
            // not exactly the one submit NEVER continues, because pi would
            // otherwise pay the tool-result inner loop again (truncated calls
            // come back terminate=false). Exactly two turns may exceed the
            // initial one, sharing ONE landing budget: a clean text-only end
            // on an 'auto' lane takes the closing reminder, and a clean submit
            // envelope rejected at the parameter-contract seam takes the
            // correction turn. Total model turns are at most initial + one.
            finishTurn: (async ({ message, toolResults }) => {
              if (observedStructuredMessage !== message && !this.abort.signal.aborted) {
                await new Promise<void>((resolve) => {
                  const done = () => {
                    this.abort.signal.removeEventListener('abort', done);
                    acknowledgeStructuredMessage = undefined;
                    resolve();
                  };
                  acknowledgeStructuredMessage = (observed) => {
                    if (observed === message) done();
                  };
                  this.abort.signal.addEventListener('abort', done, { once: true });
                });
              }
              // Abort/close releases the wait without scheduling another turn.
              // Missing or invalid streamed JSON stays terminal before either
              // landing allowance can be consumed or evidence can be reset.
              if (
                this.abort.signal.aborted ||
                observedStructuredMessage !== message ||
                invalidStructuredArguments
              ) {
                return { action: 'end' as const };
              }
              const verdict = classifySubmitTurn(
                {
                  stopReason: message.stopReason,
                  toolCallNames: message.content
                    .filter((block) => block.type === 'toolCall')
                    .map((call) => call.name),
                },
                { forced: !submitReminderAllowed },
              );
              if (verdict === 'needs_reminder') {
                return submitReminderAllowed && !landingTurnUsed
                  ? undefined
                  : { action: 'end' as const };
              }
              // The ONE correction-eligible failure: a clean single-submit
              // envelope (verdict 'landed') whose arguments were rejected at
              // the parameter-contract seam — a string-serialized
              // array/object field whose shared repair failed. The isError
              // tool result itself is the correction prompt; the inner loop
              // continues once inside the SAME run, sharing the single
              // landing budget with the missing-submit reminder AND the
              // run-scoped correction allowance nested loops also consume.
              //
              // Strict-envelope prerequisite (P1): the correction is only
              // granted when THIS turn's streamed submit bytes were strictly
              // valid JSON — a malformed outer envelope salvaged by pi's
              // parser stays terminal with its retained evidence, identical
              // to the preflight's strict JSON.parse ordering.
              if (
                verdict === 'landed' &&
                !landingTurnUsed &&
                !this.paramContractCorrectionUsed &&
                !invalidStructuredArguments &&
                toolResults.some(
                  (result) =>
                    result.toolName === STRUCTURED_OUTPUT_TOOL &&
                    isToolParamContractRejection(result),
                )
              ) {
                landingTurnUsed = true;
                this.paramContractCorrectionUsed = true;
                landingConsumer = 'param_contract';
                return undefined;
              }
              return { action: 'end' as const };
            }) satisfies FinishTurn,
          }
        : {
            // Every non-structured root loop shares the run-scoped correction
            // allowance too — an unbounded/maxTurns Copilot loop must not pay
            // for a second param-contract rejection. The caller's turn ceiling
            // keeps its normal meaning underneath the gate.
            finishTurn: this.contractCorrectionFinishTurn(
              maxTurns !== undefined
                ? turnLimiter(maxTurns, () => {
                    cappedByMaxTurns = true;
                  })
                : undefined,
            ),
          }),
      beforeToolCall: this.makeBeforeToolCall(),
      afterToolCall: this.makeAfterToolCall(),
      transformContext: this.makeTransformContext(),
      // YUK-1022 spec §3 P3 — steering/follow-up queue sources wired on the
      // ROOT loop only: steering targets the running turn, and nested loops
      // are synchronous tool executions that must not drain a parent queue.
      // No caller provides these today; the ctx surface exists so a future
      // consumer attaches without adapter surgery.
      ...(this.args.piQueues?.getSteeringMessages
        ? { getSteeringMessages: this.args.piQueues.getSteeringMessages }
        : {}),
      ...(submitReminderAllowed || this.args.piQueues?.getFollowUpMessages
        ? {
            // The C2-landing reminder fires once when the loop would stop
            // without the submit call; afterwards (and on forced lanes never)
            // the caller queue is the only follow-up source. Contract: never
            // throws — a broken delegate returns [] rather than killing the run.
            getFollowUpMessages: async () => {
              if (submitReminderAllowed && !landingTurnUsed) {
                landingTurnUsed = true;
                landingConsumer = 'missing_submit';
                return [piUserMessage(STRUCTURED_SUBMIT_REMINDER)];
              }
              try {
                return (await this.args.piQueues?.getFollowUpMessages?.()) ?? [];
              } catch {
                return [];
              }
            },
          }
        : {}),
    };

    const startedAt = Date.now();
    let numTurns = 0;
    let finalMessages: AgentMessage[] = [];
    // SDK parity: every query emits an init frame; the consume loop reads its
    // session_id (notifySdkSessionId) — pi carries the `pi:`-prefixed id.
    yield piInitFrame({
      sessionId: this.sessionId,
      model: this.model,
      tools: this.allTools,
    });
    const stream = this.deps.agentLoop(prompts, context, config, this.abort.signal, this.streamFn);
    let textStreamed = false;
    for await (const event of stream) {
      // A new assistant turn restarts the raw-arguments evidence window:
      // tool-call content indexes repeat per message, so without the reset a
      // rejected submit's streamed bytes would concatenate with the corrected
      // call's and corrupt the strict-JSON check below. Only an ELIGIBLE
      // continuation reaches a next turn — an invalid-envelope rejection ends
      // immediately, so a terminal first-turn failure can never be erased by
      // this reset.
      this.trackStreamedArgs(event, rawToolArguments, streamedArgsByCallId);
      if (event.type === 'turn_start') invalidStructuredArguments = false;
      this.observeToolAttempt(event, streamedArgsByCallId);
      // Frames queued inside the loop (subagent task_*, compact_boundary)
      // surface before the engine event that follows them — matching the SDK
      // wire order where lifecycle frames precede the parent tool_result.
      yield* this.drainFrames();
      if (
        event.type === 'message_update' &&
        event.message.role === 'assistant' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        const text = event.assistantMessageEvent.delta;
        if (text.length > 0 && !this.abort.signal.aborted) {
          textStreamed = true;
          yield { type: 'text_delta', text, session_id: this.sessionId, source: 'pi' };
        }
        continue;
      }
      if (
        event.type === 'message_update' &&
        event.message.role === 'assistant' &&
        event.assistantMessageEvent.type === 'thinking_delta'
      ) {
        const text = event.assistantMessageEvent.delta;
        if (text.length > 0 && !this.abort.signal.aborted) {
          yield { type: 'thinking_delta', text, session_id: this.sessionId, source: 'pi' };
        }
        continue;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (structuredOutput) {
          // pi's provider parser may repair malformed tool JSON. That hidden
          // repair must not consume an untracked allowance in each blind
          // pass. Reject salvaged output; only strict raw JSON reaches the
          // capability's single shared normalization budget. Missing raw
          // deltas fail closed.
          event.message.content.forEach((block, index) => {
            if (block.type !== 'toolCall') return;
            try {
              JSON.parse(rawToolArguments.get(index) ?? '');
            } catch {
              invalidStructuredArguments = true;
            }
          });
          observedStructuredMessage = event.message;
          acknowledgeStructuredMessage?.(event.message);
        }
        numTurns += 1;
        yield {
          ...piAssistantToSdkFrame(event.message as PiAssistantMessage, this.sessionId),
          ...(textStreamed ? { text_streamed: true } : {}),
        };
        textStreamed = false;
        continue;
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        yield piToolResultToSdkFrame(event.message as PiToolResultMessage, this.sessionId);
        continue;
      }
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }
    yield* this.drainFrames();
    const terminal = piTerminalResultFrame({
      messages: finalMessages,
      model: this.model,
      sessionId: this.sessionId,
      durationMs: Date.now() - startedAt,
      numTurns,
      // The internal controller is the single abort truth — it fires both
      // when the caller signal aborts (wired in the constructor) and when
      // close() tears down an in-flight query.
      aborted: this.abort.signal.aborted,
      cappedByMaxTurns,
      structuredOutputTool: structuredOutput,
      invalidStructuredArguments,
      // The original streamed submit bytes survive a structured-parse failure
      // as bounded tool_call_log evidence (adapter-level failures never reach
      // the capability, which logs its own view of the payload).
      submitLandingConsumedBy: landingConsumer,
      // The submit arguments validation/execute actually saw when the shared
      // parameter-contract repair was adopted — the capability receives this,
      // not the still-stringified raw fields.
      repairedSubmitArguments: this.repairedToolArgs.get(STRUCTURED_OUTPUT_TOOL),
      structuredSubmitEvidence:
        structuredOutput && rawToolArguments.size > 0
          ? {
              tool_name: STRUCTURED_OUTPUT_TOOL,
              // Same C6 safe boundary as the per-call evidence — streamed
              // bytes can carry escaped credential keys inside embedded JSON
              // string fields, so they pass the argument sanitizer too.
              ...rawArgumentsEvidence(
                [...rawToolArguments.values()]
                  .map((raw) =>
                    sanitizeArgumentsEvidenceText(raw, {
                      secrets: this.args.resolved.apiKey ? [this.args.resolved.apiKey] : [],
                    }),
                  )
                  .join('\n'),
              ),
            }
          : undefined,
      // YUK-1559 (C6) — the last non-2xx this query's capture fetch saw, if
      // any; the terminal frame appends it to errors[] on failure terminals.
      providerError: this.providerErrorCapture?.latest(),
      // Same shared boundary on errors[0] — pi's errorMessage can carry the
      // full unsanitized provider body; it must not bypass redaction/cap.
      sanitizeErrorMessage: this.providerErrorCapture?.sanitize,
      childUsage: this.childUsage,
    });
    if (terminal) yield terminal;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Aborting a finished loop is harmless; for a query in flight it is the
    // cooperative stop that mirrors SDK query.close().
    this.abort.abort();
    const providerHttp = this.providerHttp;
    this.providerHttp = undefined;
    await providerHttp?.close().catch(() => {});
    // Remote MCP clients hold sockets — release them with the session.
    for (const handle of this.remoteMcpHandles) {
      try {
        await handle.close();
      } catch {
        // Transport teardown must never turn a settled run into a failure.
      }
    }
  }
}

export class PiAgentAdapter implements ExecutionAdapter {
  readonly id = 'pi' as const;
  private resolved: Required<PiAdapterDeps> | undefined;

  constructor(private readonly init: PiAdapterDeps = {}) {}

  /**
   * Lazy dependency resolution — the module-level PI_ADAPTER singleton must
   * not pay the provider-catalog construction cost on import of the seam file.
   * The imports are dynamic for a second reason: migrate.cjs transitively
   * reaches this module (migrate → projections → judge → runner → seam) and
   * build:migrate marks @earendil-works/* external — a static require would
   * crash the migrate container at module load. Dynamic imports only execute
   * when startup() actually runs, which migrate never calls.
   */
  private async resolveDeps(): Promise<Required<PiAdapterDeps>> {
    if (this.resolved === undefined) {
      // Each import evaluates only when its injected dep is absent — tests
      // that inject both never load the pi tree at all.
      this.resolved = {
        // Native pi presets own wire behavior; anthropic-sub selects the
        // native Anthropic preset with the separately resolved OAuth credential.
        models: this.init.models ?? (await createLoomPiModels()),
        agentLoop: this.init.agentLoop ?? (await import('@earendil-works/pi-agent-core')).agentLoop,
        connectRemoteMcp: this.init.connectRemoteMcp ?? connectPiRemoteMcp,
      };
    }
    return this.resolved;
  }

  /**
   * Build the pi-side tool surface from the caller's declarative mounts,
   * filtered by the same effective allowedTools the SDK lane enforces
   * (`options.tools` — already `ctx.allowedTools ?? registry` resolved by
   * buildQueryOptions). Wire names are `mcp__<server>__<tool>` on both
   * engines so the allowlist match is verbatim.
   */
  private async buildTools(
    args: ExecutionAdapterStartupArgs,
    deps: Required<PiAdapterDeps>,
  ): Promise<{ tools: AgentTool[]; remoteHandles: PiRemoteMcpMountHandle[] }> {
    const mounts: PiToolMount[] = args.piToolMounts ?? [];
    const allowed = Array.isArray(args.options.tools)
      ? new Set(args.options.tools as string[])
      : undefined;
    const tools: AgentTool[] = [];
    const remoteHandles: PiRemoteMcpMountHandle[] = [];
    const outputSchema = toolOutputSchema(args.kind);
    if (outputSchema) {
      tools.push(
        piCustomTool(
          'structured_output',
          'submit',
          'Submit the final structured result exactly once — the call arguments ARE the requested output object. No second model turn or paid repair.',
          outputSchema,
          async () => ({ content: [{ type: 'text', text: 'Result captured for validation.' }] }),
        ),
      );
    }
    try {
      for (const mount of mounts) {
        if (mount.type === 'domain') {
          tools.push(
            ...buildPiDomainAgentTools({
              ...mount.options,
              // YUK-1557 — the runner owns the active run identity; it stamps
              // every bridge row even when a tool's spend owner uses another id.
              logTaskRunId: args.runId,
            }),
          );
        } else if (mount.type === 'custom') {
          tools.push(...mount.tools);
        } else {
          const handle = await deps.connectRemoteMcp(mount, args.initializeTimeoutMs, {
            taskRunId: args.runId,
            taskKind: args.kind,
          });
          remoteHandles.push(handle);
          tools.push(...handle.tools);
        }
      }
    } catch (err) {
      for (const handle of remoteHandles) {
        await handle.close().catch(() => {});
      }
      throw err;
    }
    const visible = allowed === undefined ? tools : tools.filter((tool) => allowed.has(tool.name));
    return { tools: visible, remoteHandles };
  }

  async startup(args: ExecutionAdapterStartupArgs): Promise<PreparedExecutionQuery> {
    const deps = await this.resolveDeps();
    // Fail fast inside admission but before the durable attempt row: an
    // unknown model or unresolved credential is a config error, not a paid
    // call. Both auth modes carry the credential value on `resolved.apiKey`
    // (oauth = the sk-ant-oat* subscription token the anthropic-messages
    // driver switches to Bearer).
    if (
      typeof args.options.resume === 'string' &&
      args.options.resume.length > 0 &&
      args.piSessionReplay === undefined
    ) {
      throw new Error(
        'pi adapter cannot serve options.resume without ctx.piSessionReplay — there is no provider session file; replay the durable turns instead.',
      );
    }
    const model = deps.models.getModel(piProviderId(args.resolved.provider), args.resolved.model);
    if (!model) {
      throw new Error(
        `pi adapter cannot execute '${args.resolved.provider}/${args.resolved.model}': protocol or required catalog facts (endpoint, reasoning, input modalities, context/output limits) are unknown. Model selection is unchanged.`,
      );
    }
    // YUK-1547 — the wire's reasoning_effort must have exactly one writer:
    // the options.effort tier (pi ThinkingLevel map) and the per-task
    // native reasoning_effort passthrough both serialize onto the same key.
    if (
      args.options.effort !== undefined &&
      args.resolved.nativeReasoningParams?.reasoning_effort !== undefined
    ) {
      throw new Error(
        `conflicting reasoning params for task '${args.kind}': options.effort='${args.options.effort}' and task.<kind>.reasoning reasoning_effort='${args.resolved.nativeReasoningParams.reasoning_effort}' both target the wire reasoning_effort — keep exactly one source.`,
      );
    }
    const { tools, remoteHandles } = await this.buildTools(args, deps);
    // Fail-closed rollout rule: a tool-loop kind pinned to pi but carrying no
    // pi-visible tools would silently run tool-less — reject at startup.
    // Exception: an explicitly empty `options.tools` allowlist is the caller's
    // declared intent to run tool-less (CopilotTask authoritativeReply turns
    // do exactly this), not a mount misconfiguration.
    const explicitlyToolLess = Array.isArray(args.options.tools) && args.options.tools.length === 0;
    if (tasks[args.kind].needsToolCall && tools.length === 0 && !explicitlyToolLess) {
      throw new Error(
        `Task kind '${args.kind}' declares needsToolCall but no pi-visible tools mounted (piToolMounts empty or allowedTools filtered all). Mount domain tools via piDomainMount and/or remote MCP via piRemoteMcpMount.`,
      );
    }
    return new PiPreparedQuery(args, model, deps, tools, remoteHandles);
  }
}
