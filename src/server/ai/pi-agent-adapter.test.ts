// YUK-921 P1 — pi adapter normalization + startup-gate tests. The adapter's
// deps (models catalog, agentLoop) are injectable precisely so this file can
// pin the event→SDK-frame contract without network: a scripted event stream
// stands in for the real agentLoop, and a one-model catalog stands in for
// builtinModels().

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type {
  EventStream,
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  Model as PiModel,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionAdapterStartupArgs } from './execution-adapter';
import { PiAgentAdapter } from './pi-agent-adapter';
import type { ResolvedProvider } from './providers';
import type { PiToolMount } from './tools/pi-tools';

const MODEL_ID = 'mimo-v2.5-pro';
const RUN_ID = 'task_run_test_0001';

const FAKE_MODEL: PiModel<PiApi> = {
  id: MODEL_ID,
  name: 'MiMo V2.5 Pro',
  provider: 'opencode-go',
  api: 'openai-completions',
  baseUrl: 'https://opencode.ai/zen/go',
  input: ['text'],
  contextWindow: 262_144,
  maxTokens: 32_768,
} as unknown as PiModel<PiApi>;

const RESOLVED_KEY: ResolvedProvider = {
  authMode: 'key',
  provider: 'opencode-go',
  model: MODEL_ID,
  apiKey: 'sk-opencode-test',
};

function piUsage(over: Partial<PiUsage> = {}): PiUsage {
  return {
    input: 120,
    output: 45,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 180,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    ...over,
  };
}

function piAssistant(over: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'final answer text' }],
    api: 'openai-completions',
    provider: 'opencode-go',
    model: MODEL_ID,
    responseId: 'resp_123',
    usage: piUsage(),
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    ...over,
  } as PiAssistantMessage;
}

function fakeStream(events: AgentEvent[]): EventStream<AgentEvent, AgentMessage[]> {
  return (async function* () {
    for (const event of events) yield event;
  })() as unknown as EventStream<AgentEvent, AgentMessage[]>;
}

interface CapturedLoop {
  prompts: AgentMessage[];
  context: AgentContext;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
}

function makeDeps(events: AgentEvent[], captured: Partial<CapturedLoop> = {}) {
  const agentLoop = vi.fn(
    (
      prompts: AgentMessage[],
      context: AgentContext,
      config: AgentLoopConfig,
      signal: AbortSignal | undefined,
      _streamFn: StreamFn,
    ): EventStream<AgentEvent, AgentMessage[]> => {
      captured.prompts = prompts;
      captured.context = context;
      captured.config = config;
      captured.signal = signal;
      return fakeStream(events);
    },
  );
  const models = {
    getModel: (provider: string, id: string) =>
      provider === 'opencode-go' && id === MODEL_ID ? FAKE_MODEL : undefined,
    streamSimple: vi.fn(),
  };
  return { models, agentLoop };
}

function startupArgs(over: Partial<ExecutionAdapterStartupArgs> = {}): ExecutionAdapterStartupArgs {
  // A caller-supplied partial `options` merges into (not replaces) the defaults.
  const { options: overOptions, ...rest } = over;
  const options = {
    systemPrompt: 'You are a test system prompt.',
    abortController: new AbortController(),
    ...(overOptions ?? {}),
  } as unknown as Options;
  return {
    initializeTimeoutMs: 5_000,
    resolved: RESOLVED_KEY,
    runId: RUN_ID,
    kind: 'AttributionTask',
    ...rest,
    options,
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const frame of iterable) out.push(frame);
  return out;
}

describe('PiAgentAdapter.startup — fail-fast gates', () => {
  it('rejects a non-key authMode binding before any model lookup', async () => {
    const oauthResolved: ResolvedProvider = {
      authMode: 'oauth',
      provider: 'opencode-go',
      model: MODEL_ID,
      oauthTokenEnv: 'OAUTH_TOKEN_ENV',
    };
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    await expect(adapter.startup(startupArgs({ resolved: oauthResolved }))).rejects.toThrow(
      /key-auth/,
    );
  });

  it('rejects a model id missing from the provider catalog', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    await expect(
      adapter.startup(startupArgs({ resolved: { ...RESOLVED_KEY, model: 'no-such-model' } })),
    ).rejects.toThrow(/no model 'no-such-model'/);
  });
});

describe('PiPreparedQuery.query — agentLoop wiring', () => {
  it('injects x-opencode-session = runId, resolved apiKey and effort→reasoning', async () => {
    const captured: Partial<CapturedLoop> = {};
    const events: AgentEvent[] = [
      { type: 'agent_start' },
      { type: 'message_end', message: piAssistant() },
      { type: 'agent_end', messages: [piAssistant()] },
    ];
    const deps = makeDeps(events, captured);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs();
    args.options.effort = 'high';
    const prepared = await adapter.startup(args);
    await drain(prepared.query('solve this'));

    expect(captured.config?.headers).toEqual({ 'x-opencode-session': RUN_ID });
    expect(captured.config?.apiKey).toBe('sk-opencode-test');
    expect(captured.config?.reasoning).toBe('high');
    expect(captured.config?.model).toBe(FAKE_MODEL);
    expect(captured.context?.systemPrompt).toBe('You are a test system prompt.');
    expect(captured.context?.messages).toEqual([]);
    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts?.[0]).toMatchObject({ role: 'user', content: 'solve this' });
  });

  it('converts an AsyncIterable<SDKUserMessage> prompt into pi user messages', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    async function* prompt() {
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'block one' }] },
      } as never;
      yield {
        type: 'user',
        message: { role: 'user', content: 'block two' },
      } as never;
    }
    await drain(prepared.query(prompt()));
    expect(captured.prompts).toHaveLength(2);
    expect(captured.prompts?.[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'block one' }],
    });
    expect(captured.prompts?.[1]).toMatchObject({ role: 'user', content: 'block two' });
  });

  it('rejects a preset (non-string) systemPrompt loudly', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs();
    args.options.systemPrompt = { type: 'preset', preset: 'claude_code' } as never;
    const prepared = await adapter.startup(args);
    await expect(drain(prepared.query('hi'))).rejects.toThrow(/plain string systemPrompt/);
  });
});

describe('PiPreparedQuery.query — frame normalization', () => {
  it('emits an assistant frame per message_end and a success result on agent_end', async () => {
    const assistant = piAssistant();
    const events: AgentEvent[] = [
      { type: 'agent_start' },
      { type: 'message_end', message: assistant },
      { type: 'agent_end', messages: [assistant] },
    ];
    const deps = makeDeps(events);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const frames = (await drain(prepared.query('go'))) as Record<string, never>[];

    expect(frames).toHaveLength(2);

    const assistantFrame = frames[0] as Record<string, unknown>;
    expect(assistantFrame.type).toBe('assistant');
    expect(assistantFrame.source).toBe('pi');
    expect(assistantFrame.session_id).toBe(RUN_ID);
    const inner = assistantFrame.message as Record<string, unknown>;
    expect(inner.id).toBe('resp_123');
    expect(inner.role).toBe('assistant');
    expect(inner.content).toEqual([{ type: 'text', text: 'final answer text' }]);
    expect(inner.stop_reason).toBe('end_turn');
    expect(inner.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });

    const result = frames[1] as Record<string, unknown>;
    expect(result.type).toBe('result');
    expect(result.source).toBe('pi');
    expect(result.subtype).toBe('success');
    expect(result.is_error).toBe(false);
    expect(result.result).toBe('final answer text');
    expect(result.stop_reason).toBe('end_turn');
    expect(result.total_cost_usd).toBeCloseTo(0.33);
    expect(result.num_turns).toBe(1);
    expect(result.permission_denials).toEqual([]);
    expect(result.session_id).toBe(RUN_ID);
    const usage = result.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(120);
    const modelUsage = result.modelUsage as Record<string, Record<string, unknown>>;
    expect(modelUsage[MODEL_ID].costUSD).toBeCloseTo(0.33);
    expect(modelUsage[MODEL_ID].contextWindow).toBe(262_144);
  });

  it('maps thinking and toolCall pi blocks onto the Anthropic wire', async () => {
    const assistant = piAssistant({
      content: [
        { type: 'thinking', thinking: 'let me think', thinkingSignature: 'sig_1' },
        { type: 'text', text: 'visible answer' },
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'search',
          arguments: { q: 'x' },
        },
      ] as never,
    });
    const deps = makeDeps([
      { type: 'message_end', message: assistant },
      { type: 'agent_end', messages: [assistant] },
    ]);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const frames = (await drain(prepared.query('go'))) as Record<string, unknown>[];
    const inner = (frames[0] as Record<string, unknown>).message as Record<string, unknown>;
    expect(inner.content).toEqual([
      { type: 'thinking', thinking: 'let me think', signature: 'sig_1' },
      { type: 'text', text: 'visible answer' },
      { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
    ]);
  });

  it('surfaces a provider stream error as error_during_execution', async () => {
    const failed = piAssistant({ stopReason: 'error', errorMessage: 'upstream 500' });
    const deps = makeDeps([
      { type: 'message_end', message: failed },
      { type: 'agent_end', messages: [failed] },
    ]);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const frames = (await drain(prepared.query('go'))) as Record<string, unknown>[];
    const result = frames.at(-1) as Record<string, unknown>;
    expect(result.subtype).toBe('error_during_execution');
    expect(result.is_error).toBe(true);
    expect(result.errors).toEqual(['upstream 500']);
  });

  it('reports agent_end with no assistant message as an engine error', async () => {
    const deps = makeDeps([{ type: 'agent_end', messages: [] }]);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const frames = (await drain(prepared.query('go'))) as Record<string, unknown>[];
    expect(frames).toHaveLength(1);
    const result = frames[0] as Record<string, unknown>;
    expect(result.subtype).toBe('error_during_execution');
    expect(result.errors).toEqual(['pi agent_loop ended without an assistant message']);
  });
});

describe('PiPreparedQuery — abort and close semantics', () => {
  it('emits no terminal frame when the caller signal aborted the run', async () => {
    const assistant = piAssistant({ stopReason: 'aborted' });
    const deps = makeDeps([
      { type: 'message_end', message: assistant },
      { type: 'agent_end', messages: [assistant] },
    ]);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs();
    const prepared = await adapter.startup(args);
    const iterable = prepared.query('go');
    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next(); // assistant frame
    (args.options.abortController as AbortController).abort();
    const frames: unknown[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      frames.push(step.value);
    }
    // The assistant frame was already consumed; after caller abort there must
    // be NO synthesized success result — the lifecycle's aborted flag owns
    // the cancellation truth.
    expect(frames).toHaveLength(0);
  });

  it('aborts the in-flight loop when close() is called', async () => {
    let loopSignal: AbortSignal | undefined;
    // A stream that hangs until the loop's signal aborts — mirrors a stalled
    // provider call; only close() can end it.
    const agentLoop = vi.fn(
      (
        _prompts: AgentMessage[],
        _context: AgentContext,
        _config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        _streamFn: StreamFn,
      ): EventStream<AgentEvent, AgentMessage[]> => {
        loopSignal = signal;
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'agent_end', messages: [] };
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>;
      },
    );
    const deps = {
      models: {
        getModel: () => FAKE_MODEL,
        streamSimple: vi.fn(),
      },
      agentLoop,
    };
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const iterator = prepared.query('go')[Symbol.asyncIterator]();
    const pending = iterator.next();
    await prepared.close();
    const step = await pending;
    expect(step.done).toBe(true);
    expect(loopSignal?.aborted).toBe(true);
  });

  it('rejects query() after close()', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    await prepared.close();
    expect(() => prepared.query('go')).toThrow(/closed before prompt submission/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// YUK-921 P2 (YUK-1021) — tool-loop surface: mounts, beforeToolCall parity,
// shouldStopAfterTurn → error_max_turns, toolResult→user frames, P3 guards.
// ────────────────────────────────────────────────────────────────────────────

function fakeAgentTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {} } as AgentTool['parameters'],
    execute: async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      details: null,
    }),
  };
}

function customMount(...names: string[]): PiToolMount {
  return { type: 'custom', tools: names.map(fakeAgentTool) };
}

function piToolResult(over: Record<string, unknown> = {}) {
  return {
    role: 'toolResult' as const,
    toolCallId: 'call_9',
    toolName: 'mcp__loom__read_mistakes',
    content: [{ type: 'text' as const, text: 'tool output text' }],
    isError: false,
    timestamp: 1_700_000_000_001,
    ...over,
  };
}

describe('PiAgentAdapter.startup — P2 tool mounts and P3 guards', () => {
  it('rejects a needsToolCall kind with no pi-visible tools mounted', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    await expect(adapter.startup(startupArgs({ kind: 'DreamingTask' }))).rejects.toThrow(
      /needsToolCall but no pi-visible tools/,
    );
  });

  it('rejects a needsToolCall kind when allowedTools filters out every mounted tool', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
    });
    args.options.tools = ['mcp__loom__something_else'];
    await expect(adapter.startup(args)).rejects.toThrow(/needsToolCall but no pi-visible tools/);
  });

  it('mounts pi-visible tools filtered by options.tools (allowedTools parity)', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes', 'mcp__loom__propose_knowledge')],
    });
    args.options.tools = ['mcp__loom__read_mistakes'];
    const prepared = await adapter.startup(args);
    await drain(prepared.query('go'));
    expect(captured.context?.tools?.map((t) => t.name)).toEqual(['mcp__loom__read_mistakes']);
    // Serial execution pinned — SDK in-process MCP tools run serially.
    expect(captured.config?.toolExecution).toBe('sequential');
  });

  it('rejects skills / agents / hooks / nativeCompaction at startup (P3 surfaces)', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const base = startupArgs({ piToolMounts: [customMount('mcp__loom__x')] });

    const skillsArgs = startupArgs({ piToolMounts: [customMount('mcp__loom__x')] });
    skillsArgs.options.skills = ['quiz-gen-pack'];
    await expect(adapter.startup(skillsArgs)).rejects.toThrow(/Agent Skills/);

    const agentsArgs = startupArgs({ piToolMounts: [customMount('mcp__loom__x')] });
    agentsArgs.options.agents = { scout: { description: 'd', prompt: 'p' } } as never;
    await expect(adapter.startup(agentsArgs)).rejects.toThrow(/agents/);

    const hooksArgs = startupArgs({ piToolMounts: [customMount('mcp__loom__x')] });
    hooksArgs.options.hooks = { PreToolUse: [] } as never;
    await expect(adapter.startup(hooksArgs)).rejects.toThrow(/hooks/);

    const compactArgs = startupArgs({ piToolMounts: [customMount('mcp__loom__x')] });
    compactArgs.options.settings = { autoCompactEnabled: true } as never;
    await expect(adapter.startup(compactArgs)).rejects.toThrow(/nativeCompaction/);

    // Sanity: the unmodified base starts fine.
    await adapter.startup(base);
  });
});

describe('PiPreparedQuery — beforeToolCall (canUseTool parity)', () => {
  async function captureBeforeToolCall(canUseTool: NonNullable<Options['canUseTool']>) {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
    });
    args.options.canUseTool = canUseTool;
    const prepared = await adapter.startup(args);
    await drain(prepared.query('go'));
    return captured.config?.beforeToolCall;
  }

  const callCtx = {
    toolCall: { id: 'call_1', name: 'mcp__loom__read_mistakes' },
    args: { q: 'x' },
  } as never;

  it('maps deny → {block:true, reason}', async () => {
    const beforeToolCall = await captureBeforeToolCall(async () => ({
      behavior: 'deny' as const,
      message: 'spawn budget exhausted',
    }));
    expect(await beforeToolCall?.(callCtx, undefined)).toEqual({
      block: true,
      reason: 'spawn budget exhausted',
    });
  });

  it('maps deny + interrupt → {block:true, terminate:true} (pi hard-stop)', async () => {
    const beforeToolCall = await captureBeforeToolCall(async () => ({
      behavior: 'deny' as const,
      message: 'hard stop',
      interrupt: true,
    }));
    expect(await beforeToolCall?.(callCtx, undefined)).toEqual({
      block: true,
      reason: 'hard stop',
      terminate: true,
    });
  });

  it('maps allow → undefined (no block)', async () => {
    const beforeToolCall = await captureBeforeToolCall(async () => ({
      behavior: 'allow' as const,
    }));
    expect(await beforeToolCall?.(callCtx, undefined)).toBeUndefined();
  });

  it('maps a null decision to a closed block (no out-of-band channel on pi)', async () => {
    const beforeToolCall = await captureBeforeToolCall(async () => null);
    expect(await beforeToolCall?.(callCtx, undefined)).toMatchObject({ block: true });
  });

  it('throws loudly on allow+updatedInput (argument rewriting is P3)', async () => {
    const beforeToolCall = await captureBeforeToolCall(async () => ({
      behavior: 'allow' as const,
      updatedInput: { q: 'rewritten' },
    }));
    await expect(beforeToolCall?.(callCtx, undefined)).rejects.toThrow(/updatedInput/);
  });

  it('threads toolCall name/id into the SDK-shaped callback args', async () => {
    const seen: Array<{ toolName: string; input: unknown; toolUseID?: string }> = [];
    const beforeToolCall = await captureBeforeToolCall(async (toolName, input, opts) => {
      seen.push({ toolName, input, toolUseID: opts.toolUseID });
      return { behavior: 'allow' as const };
    });
    await beforeToolCall?.(callCtx, undefined);
    expect(seen).toEqual([
      {
        toolName: 'mcp__loom__read_mistakes',
        input: { q: 'x' },
        toolUseID: 'call_1',
      },
    ]);
  });
});

describe('PiPreparedQuery — tool-loop frames and turn ceiling', () => {
  it('emits an SDK user frame per toolResult message_end', async () => {
    const assistant = piAssistant();
    const deps = makeDeps([
      { type: 'message_end', message: assistant },
      { type: 'message_end', message: piToolResult() as never },
      { type: 'agent_end', messages: [assistant, piToolResult() as never] },
    ]);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    expect(frames.map((f) => f.type)).toEqual(['assistant', 'user', 'result']);
    const userFrame = frames[1];
    expect(userFrame?.source).toBe('pi');
    const inner = userFrame?.message as { content: Array<Record<string, unknown>> };
    expect(inner.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_9',
      is_error: false,
      content: [{ type: 'text', text: 'tool output text' }],
    });
  });

  it('maps the pi turn ceiling onto SDK error_max_turns', async () => {
    const assistant = piAssistant();
    // The real loop calls config.shouldStopAfterTurn between turns; the fake
    // honors the same contract so the adapter's counter actually engages.
    const agentLoop = vi.fn(
      (
        _prompts: AgentMessage[],
        _context: AgentContext,
        config: AgentLoopConfig,
        _signal: AbortSignal | undefined,
        _streamFn: StreamFn,
      ): EventStream<AgentEvent, AgentMessage[]> =>
        (async function* () {
          yield { type: 'message_end', message: assistant } as AgentEvent;
          const stop = await config.shouldStopAfterTurn?.({
            message: assistant,
            toolResults: [],
            context: _context,
            newMessages: [assistant],
          });
          if (!stop) {
            yield { type: 'message_end', message: assistant } as AgentEvent;
          }
          yield { type: 'agent_end', messages: [assistant] } as AgentEvent;
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>,
    );
    const deps = { ...makeDeps([]), agentLoop };
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs();
    args.options.maxTurns = 1;
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const result = frames.at(-1);
    expect(result?.type).toBe('result');
    expect(result?.subtype).toBe('error_max_turns');
    expect(result?.is_error).toBe(true);
    // The loop stopped after turn 1 — no second assistant frame.
    expect(frames.filter((f) => f.type === 'assistant')).toHaveLength(1);
  });

  it('does not install shouldStopAfterTurn when maxTurns is unset', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    await drain(prepared.query('go'));
    expect(captured.config?.shouldStopAfterTurn).toBeUndefined();
  });

  it('close() releases remote MCP mount handles', async () => {
    const closed: string[] = [];
    const deps = {
      ...makeDeps([]),
      connectRemoteMcp: vi.fn(async () => ({
        tools: [fakeAgentTool('mcp__exa__web_search_exa')],
        close: async () => {
          closed.push('exa');
        },
      })),
    };
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(
      startupArgs({
        kind: 'SourcingTask',
        piToolMounts: [
          {
            type: 'remote-mcp',
            serverName: 'exa',
            config: { type: 'http', url: 'https://mcp.exa.ai/mcp' },
            toolNames: ['web_search_exa'],
          },
        ],
      }),
    );
    await prepared.close();
    expect(closed).toEqual(['exa']);
  });
});
