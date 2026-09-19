// YUK-921 P1 — ExecutionAdapter B: the pi engine behind the same seam as the
// Claude Agent SDK adapter. One agentLoop per query; its events are normalized
// into SDKMessage-shaped RunnerMessage frames (see execution-adapter.ts
// `PiRunnerMessage`) so consumeSdkAttempt keeps one lifecycle implementation.
//
// P1 scope guardrails (design §3):
//   - single-shot kinds only (needsToolCall=false allowlist, enforced upstream
//     in resolveExecutionAdapter) — no AgentTool bridge, no MCP wiring;
//   - pi-lane providers only (opencode-go today), enforced upstream;
//   - text output only — structured output stays the existing text-JSON
//     fallback exactly like the xiaomi lane (options.outputFormat ignored);
//   - abort = no terminal frame: the lifecycle's `aborted` binding produces the
//     cancellation truth, never a synthesized success.
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
import type {
  ExecutionAdapter,
  ExecutionAdapterStartupArgs,
  PiRunnerMessage,
  PreparedExecutionQuery,
  RunnerMessage,
} from './execution-adapter';

type PiModels = PiMutableModels;
type PiUserContent = Extract<PiMessage, { role: 'user' }>['content'];

/** Injectable seams so unit tests can pin behavior without network or mocks. */
export interface PiAdapterDeps {
  models?: PiModels;
  agentLoop?: typeof piAgentLoop;
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
    };
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
    });
    if (terminal) yield terminal;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Aborting a finished loop is harmless; for a query in flight it is the
    // cooperative stop that mirrors SDK query.close().
    this.abort.abort();
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
      };
    }
    return this.resolved;
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
    const model = deps.models.getModel(args.resolved.provider, args.resolved.model);
    if (!model) {
      throw new Error(
        `pi adapter has no model '${args.resolved.model}' in provider '${args.resolved.provider}' — check the opencode-go catalog for the id.`,
      );
    }
    return new PiPreparedQuery(args, model, deps);
  }
}
