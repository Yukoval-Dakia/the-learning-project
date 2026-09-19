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
//   - beforeToolCall translates ctx.canUseTool (deny → {block, reason});
//     arg-rewriting allows (updatedInput) are a P3 surface and throw loudly;
//   - toolResult messages become SDK user frames carrying tool_result blocks;
//   - skills / agents / hooks / nativeCompaction are SDK-subprocess or P3
//     surfaces — declared values fail closed at startup.
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
  PiRunnerMessage,
  PreparedExecutionQuery,
  RunnerMessage,
} from './execution-adapter';
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

function piUsageToResultUsage(usage: PiUsage | undefined, model: PiModel<PiApi>, costUsd: number) {
  return {
    usage: piUsageToSdk(usage),
    modelUsage: {
      [model.id]: {
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheReadInputTokens: usage?.cacheRead ?? 0,
        cacheCreationInputTokens: usage?.cacheWrite ?? 0,
        webSearchRequests: 0,
        costUSD: costUsd,
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
  const costUsd = usage?.cost?.total ?? 0;
  const usageParts = piUsageToResultUsage(usage, args.model, costUsd);

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

/**
 * Prepared pi query: startup holds the resolved model + session identity;
 * `query()` runs ONE agentLoop and yields normalized frames. `close()` aborts
 * the loop — the in-process equivalent of the SDK warm transport teardown.
 */
class PiPreparedQuery implements PreparedExecutionQuery {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly externalSignal: AbortSignal | undefined;

  constructor(
    private readonly args: ExecutionAdapterStartupArgs,
    private readonly model: PiModel<PiApi>,
    private readonly deps: Required<PiAdapterDeps>,
    private readonly tools: AgentTool[],
    private readonly remoteMcpHandles: PiRemoteMcpMountHandle[],
  ) {
    this.externalSignal = args.options.abortController?.signal;
    if (this.externalSignal?.aborted) {
      this.abort.abort();
    } else {
      this.externalSignal?.addEventListener('abort', () => this.abort.abort(), { once: true });
    }
  }

  query(prompt: string | AsyncIterable<SDKUserMessage>): AsyncIterable<RunnerMessage> {
    if (this.closed) {
      throw new Error('pi prepared query closed before prompt submission');
    }
    return this.iterate(collectPromptMessages(prompt));
  }

  private async *iterate(promptsPromise: Promise<AgentMessage[]>): AsyncGenerator<RunnerMessage> {
    const { options, resolved, runId } = this.args;
    const prompts = await promptsPromise;
    const context: AgentContext = {
      systemPrompt:
        typeof options.systemPrompt === 'string'
          ? options.systemPrompt
          : (() => {
              throw new Error(
                'pi adapter requires a plain string systemPrompt (claude_code presets are SDK-only)',
              );
            })(),
      messages: [],
      ...(this.tools.length > 0 ? { tools: this.tools } : {}),
    };
    // options.maxTurns is the SDK's agentic-turn ceiling. Pi has no built-in
    // equivalent — shouldStopAfterTurn counts completed turns and asks the
    // loop to end; the terminal frame then reports the SDK subtype
    // 'error_max_turns' so lifecycle/finish-reason handling stays identical.
    const maxTurns = typeof options.maxTurns === 'number' ? options.maxTurns : undefined;
    let completedTurns = 0;
    let cappedByMaxTurns = false;
    const canUseTool = options.canUseTool;
    const config: AgentLoopConfig = {
      model: this.model,
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
      // SDK in-process MCP tools run serially — pin the same execution mode
      // so batch ordering/tool_call_log sequence can't diverge by engine.
      ...(this.tools.length > 0 ? { toolExecution: 'sequential' as const } : {}),
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
      ...(canUseTool
        ? {
            beforeToolCall: async ({ toolCall, args: callArgs }, signal) => {
              const decision = await canUseTool(
                toolCall.name,
                (callArgs ?? {}) as Record<string, unknown>,
                {
                  // Pi hands a loop signal when present; otherwise fall back
                  // to the adapter's own abort so close()/caller-cancel still
                  // reaches the callback.
                  signal: signal ?? this.abort.signal,
                  toolUseID: toolCall.id,
                  requestId: toolCall.id,
                },
              );
              // SDK `null` means "the consumer answered out-of-band" — pi has
              // no such channel, so an indecisive hook must fail closed the
              // same way a deny does (the tool stays blocked with a reason).
              if (decision === null || decision === undefined) {
                return {
                  block: true,
                  reason:
                    'canUseTool returned no decision — the SDK out-of-band response channel has no pi equivalent',
                };
              }
              if (decision.behavior === 'deny') {
                // SDK deny = error tool result (agent may retry; contracts
                // memoize the same answer). `interrupt:true` is the SDK's
                // hard-stop hint — pi's equivalent is terminate (design §6
                // R5(i): {block:true} alone does NOT hard-stop).
                return {
                  block: true,
                  reason: decision.message,
                  ...(decision.interrupt ? { terminate: true } : {}),
                };
              }
              if (decision.updatedInput !== undefined) {
                throw new Error(
                  `pi adapter cannot apply canUseTool updatedInput for '${toolCall.name}' — argument rewriting is a P3 surface`,
                );
              }
              return undefined;
            },
          }
        : {}),
    };
    const streamFn: StreamFn = (model, llmContext, streamOptions) =>
      this.deps.models.streamSimple(model, llmContext, streamOptions);

    const startedAt = Date.now();
    let numTurns = 0;
    let finalMessages: AgentMessage[] = [];
    const stream = this.deps.agentLoop(prompts, context, config, this.abort.signal, streamFn);
    for await (const event of stream) {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        numTurns += 1;
        yield piAssistantToSdkFrame(event.message as PiAssistantMessage, runId);
        continue;
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult') {
        yield piToolResultToSdkFrame(event.message as PiToolResultMessage, runId);
        continue;
      }
      if (event.type === 'agent_end') {
        finalMessages = event.messages;
      }
    }
    const terminal = piTerminalResultFrame({
      messages: finalMessages,
      model: this.model,
      sessionId: runId,
      durationMs: Date.now() - startedAt,
      numTurns,
      // The internal controller is the single abort truth — it fires both
      // when the caller signal aborts (wired in the constructor) and when
      // close() tears down an in-flight query.
      aborted: this.abort.signal.aborted,
      cappedByMaxTurns,
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
    // P3+ surfaces that the pi lane cannot serve — fail closed rather than
    // silently drop a declared capability (subagent contracts, SDK hook
    // semantics, skill listing, native compaction).
    if (Array.isArray(args.options.skills) && args.options.skills.length > 0) {
      throw new Error(
        'pi adapter cannot serve Agent Skills (SDK subprocess feature); unset ctx.skills or route via sdk.',
      );
    }
    if (args.options.agents !== undefined && Object.keys(args.options.agents).length > 0) {
      throw new Error('pi adapter cannot serve Options.agents — nested subagents are P3 scope.');
    }
    if (args.options.hooks !== undefined) {
      throw new Error(
        'pi adapter cannot serve SDK hooks (PreToolUse/SessionStart) — hook semantics are P3 scope.',
      );
    }
    if (
      typeof args.options.settings === 'object' &&
      args.options.settings !== null &&
      args.options.settings.autoCompactEnabled === true
    ) {
      throw new Error(
        'pi adapter cannot serve nativeCompaction — transformContext wiring is P3 scope.',
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
    if (tasks[args.kind].needsToolCall && tools.length === 0) {
      throw new Error(
        `Task kind '${args.kind}' declares needsToolCall but no pi-visible tools mounted (piToolMounts empty or allowedTools filtered all). Mount domain tools via piDomainMount and/or remote MCP via piRemoteMcpMount.`,
      );
    }
    return new PiPreparedQuery(args, model, deps, tools, remoteHandles);
  }
}
