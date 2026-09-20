// YUK-921 P1 — ExecutionAdapter B: the pi engine behind the same seam as the
// Claude Agent SDK adapter. One agentLoop per query; its events are normalized
// into SDKMessage-shaped RunnerMessage frames (see execution-adapter.ts
// `PiRunnerMessage`) so consumeSdkAttempt keeps one lifecycle implementation.
//
// Scope guardrails (design §3):
//   - allowlisted kinds only (AI_ADAPTER_PI_KINDS, enforced upstream in
//     resolveExecutionAdapter); P1 served needsToolCall=false kinds, P2 adds
//     tool-loop kinds via ctx.piToolMounts → context.tools;
//   - pi-lane providers only (opencode-go today), enforced upstream;
//   - text output only — structured output stays the existing text-JSON
//     fallback exactly like the xiaomi lane (options.outputFormat ignored);
//   - abort = no terminal frame: the lifecycle's `aborted` binding produces the
//     cancellation truth, never a synthesized success.
//
// P2 tool-loop parity rules (design §6 R5):
//   - tools surface under the SAME `mcp__<server>__<tool>` wire names the SDK
//     lane uses, so allowedTools filtering / recordToolCall /
//     shouldEmitToolUseForCaller see identical names;
//   - maxTurns has no pi equivalent — shouldStopAfterTurn counts assistant
//     turns and the terminal frame reports the SDK subtype 'error_max_turns';
//   - beforeToolCall translates ctx.canUseTool (deny → {block, reason},
//     interrupt → terminate); arg-rewriting allows (updatedInput) throw loudly;
//   - toolResult messages become SDK user frames carrying tool_result blocks.
//
// P3 dual-descriptor rule (YUK-1022): the SDK surfaces the caller declares via
// Options (skills / agents / hooks / nativeCompaction / sdkSession.resume)
// each require their pi counterpart in the startup args — piSkillDocs,
// piAgents, piHooks, nativeCompaction, piSessionReplay — or startup fails
// closed. Served equivalents:
//   skills      → SKILL.md bodies appended to systemPrompt
//   agents      → Task/Agent AgentTools + in-process nested agentLoops
//   hooks       → piHooks bridge into beforeToolCall / afterToolCall
//   compaction  → transformContext budget-prune + bounded sessionContext
//   resume      → durable-turn replay seeded into context.messages
// Steering/follow-up are wired as a ctx surface (`ctx.piQueues` → root-loop
// getSteeringMessages/getFollowUpMessages) with NO live consumer today —
// the SDK lane never exposed queue semantics, and no current caller needs
// mid-run steering or post-stop follow-up injection.
//
// Session/header contract (spike probe 6): every opencode request needs
// `x-opencode-session`; we inject the durable run id (`ai_task_run.id`) — the
// same per-attempt fencing identity the lifecycle already owns.

import { randomUUID } from 'node:crypto';
import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
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
import { tasks } from '@/ai/registry';
import type {
  ExecutionAdapter,
  ExecutionAdapterStartupArgs,
  PiReplayTurn,
  PiRunnerMessage,
  PreparedExecutionQuery,
  RunnerMessage,
} from './execution-adapter';
import { emitPiAfterToolCall, runPiBeforeToolCall } from './pi-hooks';
import { isSpawnToolName } from './spawn-contract';
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
} from './tools/pi-tools';

type PiModels = PiMutableModels;
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

/**
 * Pi session ids carry a `pi:` prefix so a persisted `agent_sdk_session_id`
 * can never be mistaken for an SDK session file name. The SDK lane folds any
 * `pi:`-prefixed resume pointer to a cold start (copilot-execution computes
 * the caller-side resume), and the pi lane reuses the id verbatim on resume
 * so context-digest delivery gating (`shouldDeliverCopilotSessionContext`)
 * keeps its per-session memory.
 */
export const PI_SESSION_ID_PREFIX = 'pi:';

/** `pi:`-prefixed durable session ids are pi-lane owned — an SDK run must
 *  cold-start them (no provider session file exists), a pi run reuses the id
 *  and seeds context from the caller's durable-turn replay. */
export function isPiSessionId(sessionId: string): boolean {
  return sessionId.startsWith(PI_SESSION_ID_PREFIX);
}

/**
 * Rough chars-per-token divisor for the transformContext compaction trigger.
 * The estimate only decides WHEN to prune — the durable evidence is the
 * compact_boundary frame's own pre/post counts, not billing usage.
 */
const PI_COMPACT_CHARS_PER_TOKEN = 4;
/** Compact when estimated context tokens exceed this share of the window. */
const PI_COMPACT_TRIGGER_RATIO = 0.85;
/** Prune back to this share of the window (headroom for the reply). */
const PI_COMPACT_TARGET_RATIO = 0.6;

function piSessionIdFor(optionsResume: string | undefined): string {
  return optionsResume?.startsWith(PI_SESSION_ID_PREFIX)
    ? optionsResume
    : `${PI_SESSION_ID_PREFIX}${randomUUID()}`;
}

/** Estimate context tokens over the LLM-visible text of a message list. */
function estimatePiTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'toolResult') {
      const content = message.content;
      if (typeof content === 'string') {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') chars += block.text.length;
        }
      }
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') chars += JSON.stringify(block.arguments).length;
      }
    }
  }
  return Math.ceil(chars / PI_COMPACT_CHARS_PER_TOKEN);
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
  } as unknown as PiRunnerMessage;
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
  } as unknown as PiRunnerMessage;
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
  } as unknown as PiRunnerMessage;
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
  } as unknown as PiRunnerMessage;
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
  } as unknown as PiRunnerMessage;
}

function piUserMessage(content: PiUserContent): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Convert one SDK user message into pi's UserMessage. Text and base64 images
 * map 1:1; url image sources and tool_result blocks are outside the P1 lane —
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
      `pi adapter cannot carry SDK user block '${block.type}' — url images / tool results are outside the P1 single-shot lane`,
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
  return { ...sdkMessage, source: 'pi' } as unknown as PiRunnerMessage;
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
  /** Set when shouldStopAfterTurn hit the configured turn ceiling — the pi
   *  equivalent of the SDK's `error_max_turns` terminal subtype. */
  cappedByMaxTurns?: boolean;
  /** P3 — nested-child usage rolled into the run's terminal evidence, the
   *  same way the SDK result aggregates subagent tokens into modelUsage. */
  childUsage?: PiChildUsage;
}): PiRunnerMessage | undefined {
  const final = lastAssistantMessage(args.messages);
  const base = {
    source: 'pi' as const,
    type: 'result' as const,
    duration_ms: args.durationMs,
    duration_api_ms: args.durationMs,
    num_turns: Math.max(1, args.numTurns),
    permission_denials: [],
    uuid: randomUUID(),
    session_id: args.sessionId,
  };
  const usage = final?.usage;
  const child = args.childUsage;
  const costUsd = (usage?.cost?.total ?? 0) + (child?.costUsd ?? 0);
  const usageParts = piUsageToResultUsage(usage, args.model);
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
      errors: [final?.errorMessage ?? 'pi agent aborted by provider'],
      ...usageParts,
    } as unknown as SDKResultMessage & { source: 'pi' };
  }
  if (!final) {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: 0,
      errors: ['pi agent_loop ended without an assistant message'],
      ...usageParts,
    } as unknown as SDKResultMessage & { source: 'pi' };
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
    } as unknown as SDKResultMessage & { source: 'pi' };
  }
  if (final.stopReason === 'error') {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      total_cost_usd: costUsd,
      errors: [final.errorMessage ?? 'pi stream error'],
      ...usageParts,
    } as unknown as SDKResultMessage & { source: 'pi' };
  }
  return {
    ...base,
    subtype: 'success',
    is_error: false,
    result: assistantText(final),
    stop_reason: piStopReasonToSdk(final.stopReason),
    total_cost_usd: costUsd,
    structured_output: undefined,
    ...usageParts,
  } as unknown as SDKResultMessage & { source: 'pi' };
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

  constructor(
    private readonly args: ExecutionAdapterStartupArgs,
    private readonly model: PiModel<PiApi>,
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
    this.allTools = [...tools, ...visibleSpawn];
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
   * The composed beforeToolCall gate for one loop level. Order mirrors the
   * SDK lane: caller-declared hook gates (piHooks — spawn-contract /
   * cancellation / finalization) run first; the SDK-shaped `canUseTool`
   * callback runs last. `agentType` marks nested calls — the pi equivalent of
   * the SDK hook input's `agent_id` (reply-finalization marks `root_call`).
   */
  private makeBeforeToolCall(agentType?: string): AgentLoopConfig['beforeToolCall'] {
    const { options } = this.args;
    const piHooks = this.args.piHooks;
    const canUseTool = options.canUseTool;
    if (!piHooks?.beforeToolCall?.length && !canUseTool) return undefined;
    return async ({ toolCall, args: callArgs }: BeforeToolCallContext, signal) => {
      const effectiveSignal = signal ?? this.abort.signal;
      const hooked = await runPiBeforeToolCall(
        piHooks,
        { id: toolCall.id, name: toolCall.name, ...(agentType ? { agentType } : {}) },
        (callArgs ?? {}) as Record<string, unknown>,
        effectiveSignal,
      );
      if (hooked !== undefined) return hooked;
      if (!canUseTool) return undefined;
      const decision = await canUseTool(
        toolCall.name,
        (callArgs ?? {}) as Record<string, unknown>,
        {
          // Pi hands a loop signal when present; otherwise fall back to the
          // adapter's own abort so close()/caller-cancel still reaches the
          // callback.
          signal: effectiveSignal,
          toolUseID: toolCall.id,
          requestId: toolCall.id,
        },
      );
      // SDK `null` means "the consumer answered out-of-band" — pi has no such
      // channel, so an indecisive hook must fail closed the same way a deny
      // does (the tool stays blocked with a reason).
      if (decision === null || decision === undefined) {
        return {
          block: true,
          reason:
            'canUseTool returned no decision — the SDK out-of-band response channel has no pi equivalent',
        };
      }
      if (decision.behavior === 'deny') {
        // SDK deny = error tool result (agent may retry; contracts memoize
        // the same answer). `interrupt:true` is the SDK's hard-stop hint —
        // pi's equivalent is terminate (design §6 R5(i): {block:true} alone
        // does NOT hard-stop).
        return {
          block: true,
          reason: decision.message,
          ...(decision.interrupt ? { terminate: true } : {}),
        };
      }
      if (decision.updatedInput !== undefined) {
        throw new Error(
          `pi adapter cannot apply canUseTool updatedInput for '${toolCall.name}' — argument rewriting is not supported on this lane`,
        );
      }
      return undefined;
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
    const contextWindow = this.model.contextWindow;
    const triggerTokens = Math.floor(contextWindow * PI_COMPACT_TRIGGER_RATIO);
    const targetTokens = Math.floor(contextWindow * PI_COMPACT_TARGET_RATIO);
    const isSessionContextMessage = (message: AgentMessage): boolean =>
      message.role === 'user' &&
      (message.content === sessionContext ||
        (Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'text' && block.text === sessionContext)));

    return async (messages) => {
      try {
        const preTokens = estimatePiTokens(messages);
        if (preTokens <= triggerTokens) return messages;
        const startedAt = Date.now();
        // Keep the newest tail that fits the target; the current-turn prompt
        // is the last element and is never dropped.
        const kept: AgentMessage[] = [];
        let budget = targetTokens;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i];
          const cost = estimatePiTokens([message]);
          if (kept.length > 0 && cost > budget) break;
          kept.unshift(message);
          budget -= cost;
          if (i === 0) break;
        }
        // A fresh injection replaces any previously injected copy so repeated
        // compactions never stack duplicate session contexts.
        const tail = kept.filter((message) => !isSessionContextMessage(message));
        // Boundary cleanup: if the retained head is a toolResult, its paired
        // assistant toolCall was just cut — an orphan toolResult gets rejected
        // by the provider. Trim leading orphans (never the last element: that
        // is the current-turn prompt).
        while (tail.length > 1 && tail[0].role === 'toolResult') {
          tail.shift();
        }
        const transformed: AgentMessage[] = [piUserMessage(sessionContext), ...tail];
        this.emitFrame(
          piCompactBoundaryFrame({
            sessionId,
            preTokens,
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

  /** Shared config fields every loop level (root + nested) reuses. */
  private baseLoopConfig(): Pick<
    AgentLoopConfig,
    'convertToLlm' | 'headers' | 'apiKey' | 'reasoning'
  > {
    const { options, resolved, runId } = this.args;
    return {
      // All prompts are standard LLM messages — identity conversion narrowed
      // to the LLM roles the union type needs. UI-only AgentMessages never
      // reach this lane (loom owns the durable transcript).
      convertToLlm: (messages): PiMessage[] =>
        messages.filter(
          (m): m is PiMessage =>
            m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
        ),
      headers: { [OPENCODE_SESSION_HEADER]: runId },
      // Per-request credential from the lifecycle-resolved binding — the same
      // env resolution the SDK lane does once in resolveTaskProvider, never a
      // second env read inside the engine. startup() already rejected
      // non-key lanes; keep the narrowing explicit for the type system.
      ...(resolved.authMode === 'key' ? { apiKey: resolved.apiKey } : {}),
      ...(options.effort !== undefined ? { reasoning: options.effort } : {}),
    };
  }

  private readonly streamFn: StreamFn = (model, llmContext, streamOptions) =>
    this.deps.models.streamSimple(model, llmContext, streamOptions);

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
    runNested: async ({ toolCallId, subagentType, description, prompt, spec, signal }) => {
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
      const childSignal = signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal;
      const childContext: AgentContext = {
        systemPrompt: spec.prompt,
        messages: [],
        ...(childTools.length > 0 ? { tools: childTools } : {}),
      };
      const childMaxTurns = spec.maxTurns;
      let childTurns = 0;
      let toolUses = 0;
      let totalTokens = 0;
      let lastToolName: string | undefined;
      const childConfig: AgentLoopConfig = {
        model: childModel,
        ...this.baseLoopConfig(),
        ...(childTools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
        ...(childMaxTurns !== undefined
          ? {
              shouldStopAfterTurn: () => {
                childTurns += 1;
                return childTurns >= childMaxTurns;
              },
            }
          : {}),
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
      try {
        const stream = this.deps.agentLoop(
          [piUserMessage(prompt)],
          childContext,
          childConfig,
          childSignal,
          this.streamFn,
        );
        for await (const event of stream) {
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
        // Provider-side failure parity with the root loop's terminal
        // normalization: a child whose last assistant reports error/aborted
        // is a failed subagent (error tool result), never a completed one —
        // otherwise the parent answers from a report that does not exist.
        if (final?.stopReason === 'error' || final?.stopReason === 'aborted') {
          throw new Error(
            final.errorMessage ??
              `nested subagent '${subagentType}' ended with stopReason='${final.stopReason}'`,
          );
        }
        const text = final ? assistantText(final) : '';
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
  };

  /** Resolve a spec.model override: 'inherit'/unset → parent model; a pi
   *  catalog id resolves under the run's provider; anything else (SDK alias
   *  names like 'sonnet') fails closed. */
  private childModelFor(spec: PiSubagentSpec): PiModel<PiApi> {
    const declared = spec.model;
    if (declared === undefined || declared === 'inherit') return this.model;
    const resolved = this.deps.models.getModel(this.args.resolved.provider, declared);
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
    const context: AgentContext = {
      systemPrompt,
      // sdkSession→本地回放: durable-turn replay seeds context.messages — the
      // pi equivalent of reattaching an SDK session file.
      messages: piReplayTurnsToMessages(this.args.piSessionReplay ?? [], this.model),
      ...(this.allTools.length > 0 ? { tools: this.allTools } : {}),
    };
    // options.maxTurns is the SDK's agentic-turn ceiling. Pi has no built-in
    // equivalent — shouldStopAfterTurn counts completed turns and asks the
    // loop to end; the terminal frame then reports the SDK subtype
    // 'error_max_turns' so lifecycle/finish-reason handling stays identical.
    const maxTurns = typeof options.maxTurns === 'number' ? options.maxTurns : undefined;
    let completedTurns = 0;
    let cappedByMaxTurns = false;
    const config: AgentLoopConfig = {
      model: this.model,
      ...this.baseLoopConfig(),
      // SDK in-process MCP tools run serially — pin the same execution mode
      // so batch ordering/tool_call_log sequence can't diverge by engine.
      ...(this.allTools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
      ...(maxTurns !== undefined
        ? {
            shouldStopAfterTurn: () => {
              completedTurns += 1;
              if (completedTurns >= maxTurns) {
                cappedByMaxTurns = true;
                return true;
              }
              return false;
            },
          }
        : {}),
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
      ...(this.args.piQueues?.getFollowUpMessages
        ? { getFollowUpMessages: this.args.piQueues.getFollowUpMessages }
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
    for await (const event of stream) {
      // Frames queued inside the loop (subagent task_*, compact_boundary)
      // surface before the engine event that follows them — matching the SDK
      // wire order where lifecycle frames precede the parent tool_result.
      yield* this.drainFrames();
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        numTurns += 1;
        yield piAssistantToSdkFrame(event.message as PiAssistantMessage, this.sessionId);
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
      childUsage: this.childUsage,
    });
    if (terminal) yield terminal;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Aborting a finished loop is harmless; for a query in flight it is the
    // cooperative stop that mirrors SDK query.close().
    this.abort.abort();
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
        models:
          this.init.models ?? (await import('@earendil-works/pi-ai/providers/all')).builtinModels(),
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
    try {
      for (const mount of mounts) {
        if (mount.type === 'domain') {
          tools.push(...buildPiDomainAgentTools(mount.options));
        } else if (mount.type === 'custom') {
          tools.push(...mount.tools);
        } else {
          const handle = await deps.connectRemoteMcp(mount, args.initializeTimeoutMs);
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
    // unknown model or wrong auth lane is a config error, not a paid call.
    if (args.resolved.authMode !== 'key') {
      throw new Error(
        `pi adapter requires a key-auth provider binding; '${args.resolved.provider}' resolved to oauth.`,
      );
    }
    // P3 dual-descriptor rule (YUK-1022): every SDK surface a caller declares
    // must carry its pi counterpart in the startup args, else the run fails
    // closed inside admission rather than silently dropping a declared
    // capability. The surfaces and their pi equivalents:
    //   ctx.skills          → args.piSkillDocs (system-prompt injection)
    //   ctx.agents          → args.piAgents (in-process nested agentLoops)
    //   ctx.hooks           → args.piHooks (beforeToolCall/afterToolCall bridge)
    //   ctx.nativeCompaction → args.nativeCompaction (transformContext)
    //   ctx.sdkSession.resume → options.resume + args.piSessionReplay
    const declaredSkills = Array.isArray(args.options.skills) ? args.options.skills : [];
    if (declaredSkills.length > 0) {
      const docNames = new Set((args.piSkillDocs ?? []).map((doc) => doc.name));
      const missing = declaredSkills.filter((name) => !docNames.has(name));
      if (missing.length > 0) {
        throw new Error(
          `pi adapter cannot serve skills [${missing.join(', ')}] — no resolved SKILL.md body in ctx.piSkillDocs (SDK filesystem skills are subprocess-only).`,
        );
      }
    }
    const declaredAgents = args.options.agents ? Object.keys(args.options.agents) : [];
    if (declaredAgents.length > 0) {
      const missing = declaredAgents.filter((name) => args.piAgents?.[name] === undefined);
      if (missing.length > 0) {
        throw new Error(
          `pi adapter cannot serve Options.agents [${missing.join(', ')}] — declare ctx.piAgents specs (createPiSpawnContract) alongside the SDK surface.`,
        );
      }
    }
    // buildQueryOptions injects a SessionStart hook for the compaction
    // context re-introduction — the pi lane serves that through
    // args.nativeCompaction → transformContext, so SessionStart-only hooks
    // need no piHooks. Any other declared hook event requires the bridge.
    const callerHookEvents = Object.keys(args.options.hooks ?? {}).filter(
      (event) => event !== 'SessionStart',
    );
    if (callerHookEvents.length > 0 && args.piHooks === undefined) {
      throw new Error(
        `pi adapter cannot serve SDK hooks [${callerHookEvents.join(', ')}] — declare ctx.piHooks (the engine-neutral beforeToolCall/afterToolCall bridge) alongside ctx.hooks.`,
      );
    }
    if (
      typeof args.options.settings === 'object' &&
      args.options.settings !== null &&
      args.options.settings.autoCompactEnabled === true &&
      args.nativeCompaction === undefined
    ) {
      throw new Error(
        'pi adapter cannot serve nativeCompaction — declare ctx.nativeCompaction so transformContext gets the bounded sessionContext.',
      );
    }
    if (
      typeof args.options.resume === 'string' &&
      args.options.resume.length > 0 &&
      args.piSessionReplay === undefined
    ) {
      throw new Error(
        'pi adapter cannot serve options.resume without ctx.piSessionReplay — the SDK session file has no pi equivalent; replay the durable turns instead.',
      );
    }
    const model = deps.models.getModel(args.resolved.provider, args.resolved.model);
    if (!model) {
      throw new Error(
        `pi adapter has no model '${args.resolved.model}' in provider '${args.resolved.provider}' — check the opencode-go catalog for the id.`,
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
