// pi event → SDKMessage frame normalization for the pi execution adapter.
// Frames are the only shapes `consumeSdkAttempt`/lifecycle understand; keep the
// wire vocabulary here so terminal result assembly and loop control stay apart.

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
import type { SDKAssistantMessage, SDKUserMessage } from './sdk-types';

export type PiUserContent = Extract<PiMessage, { role: 'user' }>['content'];
export type PiToolResultMessage = Extract<PiMessage, { role: 'toolResult' }>;

export const EMPTY_PI_USAGE: PiUsage = {
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
export function sdkUserMessageToPi(msg: SDKUserMessage): AgentMessage {
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

export function piUsageToSdk(usage: PiUsage | undefined): {
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
export function piStopReasonToSdk(
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
export function piContentToSdk(content: PiAssistantMessage['content']): ContentBlock[] {
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
