// Pi ↔ runner protocol codec. Inbound durable replay and SDK prompts become
// AgentMessages. Outbound pi events become SDK-shaped PiRunnerMessage frames.
// The adapter still owns the loop, clocks, abort, and when a frame is emitted.

import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  Model as PiModel,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';
import type { PiReplayTurn, PiRunnerMessage } from './execution-adapter';
import { hasPiUsageEvidence } from './pi-usage-evidence';
import type { ProviderErrorEvidence } from './provider-error-evidence';
import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from './sdk-types';
import { STRUCTURED_OUTPUT_SUBMIT_TOOL } from './structured-submit';

const STRUCTURED_OUTPUT_TOOL = STRUCTURED_OUTPUT_SUBMIT_TOOL;

type PiUserContent = Extract<PiMessage, { role: 'user' }>['content'];
export type PiToolResultMessage = Extract<PiMessage, { role: 'toolResult' }>;

const EMPTY_PI_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Replay turns → AgentMessages for `context.messages`. `convertToLlm` reads only
 * role+content; the assistant envelope is honest bookkeeping, not provider data.
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
export function piInitFrame(args: {
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

export function piCompactBoundaryFrame(args: {
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
export function piTaskStartedFrame(args: {
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

export function piTaskProgressFrame(args: {
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

export function piTaskUpdatedFrame(args: {
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

export function piUserMessage(content: PiUserContent): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Convert one SDK user message into pi's UserMessage. url image sources are
 * rejected in runner.ts; a tool_result block reaching here throws rather than
 * becoming a malformed request (the adapter synthesizes those frames itself).
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

export async function collectPromptMessages(
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
 * Map pi content blocks to their Anthropic-wire shape; toolCall → tool_use
 * keeps the tool_call_log recorder's contract. Unknown blocks are dropped.
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
 * pi AssistantMessage → SDKAssistantMessage frame; provider data is real, only
 * the Anthropic envelope is synthesized.
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
 * pi ToolResultMessage → SDK user frame carrying a tool_result block, mirroring
 * the SDK wire sequence. `consumeSdkAttempt` ignores these frames today.
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

export function lastAssistantMessage(messages: AgentMessage[]): PiAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role === 'assistant') return msg as PiAssistantMessage;
  }
  return undefined;
}

export function assistantText(message: PiAssistantMessage): string {
  let out = '';
  for (const block of message.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/**
 * Build the terminal result frame. Returns undefined on caller abort: the absent
 * terminal frame is what lets the lifecycle's `aborted` truth win.
 */
export function piTerminalResultFrame(args: {
  messages: AgentMessage[];
  model: PiModel<PiApi>;
  sessionId: string;
  durationMs: number;
  numTurns: number;
  aborted: boolean;
  /** Set when finishTurn hit the turn ceiling ('error_max_turns'). */
  cappedByMaxTurns?: boolean;
  /** Only the opt-in structured task uses tool arguments as its terminal result. */
  structuredOutputTool?: boolean;
  /** Reject pi best-effort JSON salvage: streamed arguments must parse strictly. */
  invalidStructuredArguments?: boolean;
  /** YUK-1547 — the run's ONE shared landing turn was already consumed and the
   *  submit still did not land; the name is reported in the terminal error. */
  submitLandingConsumedBy?: 'missing_submit' | 'param_contract';
  /** YUK-1547 (C1) — submit arguments AFTER the shared parameter-contract repair,
   *  i.e. what validation and execute saw. Raw streamed bytes stay the evidence. */
  repairedSubmitArguments?: unknown;
  /** Bounded raw-arguments evidence for the structured-failure terminal. */
  structuredSubmitEvidence?: {
    tool_name: string;
    raw_arguments: string;
    raw_args_sha256: string;
    truncated: boolean;
  };
  /** YUK-1559 (C6) — sanitized provider error body from the query's fetch; it
   *  rides errors[] so the raw non-2xx body reaches error_message. */
  providerError?: ProviderErrorEvidence;
  /** Safe rejection bound to the same final root assistant, never query.latest. */
  providerRequestRejection?: { http_status: 400 };
  /** YUK-1559 (C6) — the capture's shared sanitize+bound for retained provider
   *  text, applied to pi's errorMessage (errors[0]) so the full unsanitized body
   *  cannot bypass credential redaction or the 4096B cap. */
  sanitizeErrorMessage?: (text: string) => string;
  /** Nested-child usage merged into the terminal totals (SDK result parity). */
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
  // so it survives verbatim; errors[0] stays pi's formatted message.
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
      ...(args.providerRequestRejection
        ? { provider_request_rejection: args.providerRequestRejection }
        : {}),
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
    // YUK-1547 — the submit call's arguments ARE the structured output; there is
    // no {result: ...} envelope. When the parameter-contract repair was adopted
    // the capability sees the REPAIRED arguments; raw streamed bytes stay the
    // tool_call_log evidence.
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

/** Nested-child usage rolled into the parent terminal (SDK result parity). */
export interface PiChildUsage {
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

export function emptyPiChildUsage(): PiChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, byModel: new Map() };
}
