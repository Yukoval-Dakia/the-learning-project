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

  it('forwards ctx.piQueues into the root loop config (wired surface, no consumer today)', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const getSteeringMessages = vi.fn(async () => []);
    const getFollowUpMessages = vi.fn(async () => []);
    const prepared = await adapter.startup(
      startupArgs({ piQueues: { getSteeringMessages, getFollowUpMessages } }),
    );
    await drain(prepared.query('solve this'));
    expect(captured.config?.getSteeringMessages).toBe(getSteeringMessages);
    expect(captured.config?.getFollowUpMessages).toBe(getFollowUpMessages);
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

    // YUK-1022 — frame[0] is the SDK-shaped init frame carrying the
    // `pi:`-prefixed session id; assistant/result follow.
    expect(frames).toHaveLength(3);
    const initFrame = frames[0] as Record<string, unknown>;
    expect(initFrame.type).toBe('system');
    expect(initFrame.subtype).toBe('init');
    expect(initFrame.session_id).toMatch(/^pi:/);

    const assistantFrame = frames[1] as Record<string, unknown>;
    expect(assistantFrame.type).toBe('assistant');
    expect(assistantFrame.source).toBe('pi');
    expect(assistantFrame.session_id).toBe(initFrame.session_id);
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

    const result = frames[2] as Record<string, unknown>;
    expect(result.type).toBe('result');
    expect(result.source).toBe('pi');
    expect(result.subtype).toBe('success');
    expect(result.is_error).toBe(false);
    expect(result.result).toBe('final answer text');
    expect(result.stop_reason).toBe('end_turn');
    expect(result.total_cost_usd).toBeCloseTo(0.33);
    expect(result.num_turns).toBe(1);
    expect(result.permission_denials).toEqual([]);
    expect(result.session_id).toBe(initFrame.session_id);
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
    const inner = (frames[1] as Record<string, unknown>).message as Record<string, unknown>;
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
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' });
    const result = frames[1] as Record<string, unknown>;
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
    await iterator.next(); // init frame (P3: session marker precedes stream events)
    await iterator.next(); // assistant frame
    (args.options.abortController as AbortController).abort();
    const frames: unknown[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      frames.push(step.value);
    }
    // The init+assistant frames were already consumed; after caller abort
    // there must be NO synthesized success result — the lifecycle's aborted
    // flag owns the cancellation truth.
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
    await iterator.next(); // init frame — the loop only starts on the next pull
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
    await expect(adapter.startup(skillsArgs)).rejects.toThrow(/cannot serve skills/);

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
    expect(frames.map((f) => f.type)).toEqual(['system', 'assistant', 'user', 'result']);
    const userFrame = frames[2];
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

// ────────────────────────────────────────────────────────────────────────────
// YUK-921 P3 (YUK-1022) — session replay, skills, compaction, hook bridge and
// nested-subagent surfaces.
// ────────────────────────────────────────────────────────────────────────────

describe('PiPreparedQuery — P3 session replay (sdkSession → piSessionReplay)', () => {
  const replay = [
    { role: 'context' as const, text: 'PINNED LEARNER HEADER' },
    { role: 'user' as const, text: 'first question' },
    { role: 'assistant' as const, text: 'first answer' },
  ];

  it('reuses a pi: resume id and seeds context.messages from durable turns', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({ piSessionReplay: replay });
    args.options.resume = 'pi:existing-session-id';
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('follow-up'))) as Record<string, unknown>[];

    expect((frames[0] as Record<string, unknown>).session_id).toBe('pi:existing-session-id');
    const messages = captured.context?.messages ?? [];
    expect(messages).toHaveLength(3);
    // 'context' turns fold into user-role messages — the same position the
    // pinned header occupies in the cold-start envelope.
    expect(messages[0]).toMatchObject({ role: 'user', content: 'PINNED LEARNER HEADER' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'first question' });
    // Historical assistant text becomes a valid assistant message under the
    // resolved model's envelope (honest bookkeeping, not fabricated usage).
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
      api: 'openai-completions',
      provider: 'opencode-go',
      model: MODEL_ID,
      stopReason: 'stop',
    });
    expect((messages[2] as PiAssistantMessage).usage.totalTokens).toBe(0);
  });

  it('fails closed on options.resume without piSessionReplay', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs();
    args.options.resume = 'pi:orphan-session';
    await expect(adapter.startup(args)).rejects.toThrow(
      /options\.resume without ctx\.piSessionReplay/,
    );
  });

  it('mints a fresh pi: id when resume is absent or names a non-pi session', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);

    const cold = await adapter.startup(startupArgs());
    const coldFrames = (await drain(cold.query('go'))) as Record<string, unknown>[];
    const coldSession = (coldFrames[0] as Record<string, unknown>).session_id as string;
    expect(coldSession).toMatch(/^pi:/);

    // A non-pi resume value must not be echoed back — the SDK uuid belongs to
    // a different lane's session file; pi always owns a pi:-prefixed marker.
    const foldedArgs = startupArgs({ piSessionReplay: replay });
    foldedArgs.options.resume = 'sdk-session-uuid-9';
    const foldedPrepared = await adapter.startup(foldedArgs);
    const foldedFrames = (await drain(foldedPrepared.query('go'))) as Record<string, unknown>[];
    const foldedSession = (foldedFrames[0] as Record<string, unknown>).session_id as string;
    expect(foldedSession).toMatch(/^pi:/);
    expect(foldedSession).not.toBe('sdk-session-uuid-9');
    expect(foldedSession).not.toBe(coldSession);
  });
});

describe('PiPreparedQuery — P3 skills injection', () => {
  it('appends resolved SKILL.md bodies to the system prompt', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      piToolMounts: [customMount('mcp__loom__x')],
      piSkillDocs: [
        { name: 'quiz-gen-pack', body: 'SKILL BODY: always cite sources.' },
        { name: 'tone-pack', body: 'SECOND BODY: keep it short.' },
      ],
    });
    args.options.skills = ['quiz-gen-pack', 'tone-pack'];
    const prepared = await adapter.startup(args);
    await drain(prepared.query('go'));
    expect(captured.context?.systemPrompt).toBe(
      'You are a test system prompt.\n\n' +
        '<skill name="quiz-gen-pack">\nSKILL BODY: always cite sources.\n</skill>\n\n' +
        '<skill name="tone-pack">\nSECOND BODY: keep it short.\n</skill>',
    );
  });

  it('fails closed when a declared skill has no resolved body', async () => {
    const deps = makeDeps([]);
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      piToolMounts: [customMount('mcp__loom__x')],
      piSkillDocs: [{ name: 'quiz-gen-pack', body: 'x' }],
    });
    args.options.skills = ['quiz-gen-pack', 'missing-pack'];
    await expect(adapter.startup(args)).rejects.toThrow(/cannot serve skills \[missing-pack\]/);
  });
});

describe('PiPreparedQuery — P3 native compaction (transformContext)', () => {
  const compactionArgs = () => {
    const args = startupArgs({ nativeCompaction: { sessionContext: 'BOUNDED LEARNER CTX' } });
    args.options.settings = { autoCompactEnabled: true } as never;
    return args;
  };

  it('does not install transformContext without ctx.nativeCompaction', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(startupArgs());
    await drain(prepared.query('go'));
    expect(captured.config?.transformContext).toBeUndefined();
  });

  it('passes messages through under the trigger ratio', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(compactionArgs());
    await drain(prepared.query('go'));
    const transform = captured.config?.transformContext;
    expect(transform).toBeTypeOf('function');
    const small = [{ role: 'user', content: 'small', timestamp: 1 } as AgentMessage];
    expect(await transform?.(small)).toBe(small);
  });

  it('prunes the oldest turns to target, re-injects sessionContext once, and emits compact_boundary', async () => {
    let transformed: AgentMessage[] = [];
    const assistant = piAssistant();
    // The fake loop drives transformContext itself with an over-trigger
    // transcript, exactly where the real loop calls it before the LLM call.
    const agentLoop = vi.fn(
      (
        _prompts: AgentMessage[],
        _context: AgentContext,
        config: AgentLoopConfig,
        _signal: AbortSignal | undefined,
        _streamFn: StreamFn,
      ): EventStream<AgentEvent, AgentMessage[]> =>
        (async function* () {
          const big: AgentMessage[] = [
            { role: 'user', content: 'a'.repeat(700_000), timestamp: 1 },
            { role: 'user', content: 'b'.repeat(200_000), timestamp: 2 },
            { role: 'user', content: 'c'.repeat(100_000), timestamp: 3 },
          ] as AgentMessage[];
          transformed = (await config.transformContext?.(big)) ?? big;
          yield { type: 'message_end', message: assistant } as AgentEvent;
          yield { type: 'agent_end', messages: [assistant] } as AgentEvent;
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>,
    );
    const deps = { ...makeDeps([]), agentLoop };
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(compactionArgs());
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;

    // 262144-window × 0.6 target ≈ 157k tokens ≈ 629k chars: the 700k head is
    // pruned, the 200k+100k tail is kept, sessionContext is re-injected first.
    expect(transformed).toHaveLength(3);
    expect(transformed[0]).toMatchObject({ role: 'user', content: 'BOUNDED LEARNER CTX' });
    expect((transformed[1] as { content: string }).content).toHaveLength(200_000);
    expect((transformed[2] as { content: string }).content).toHaveLength(100_000);

    const boundary = frames.find((f) => f.subtype === 'compact_boundary');
    expect(boundary).toBeDefined();
    expect(boundary).toMatchObject({
      source: 'pi',
      type: 'system',
      compact_metadata: { trigger: 'auto' },
    });
    const meta = boundary?.compact_metadata as Record<string, number>;
    expect(meta.pre_tokens).toBe(250_000);
    expect(meta.post_tokens).toBeLessThan(meta.pre_tokens);
    // Ordering: the boundary surfaces before the assistant frame that follows
    // the compaction — the SDK wire order.
    const order = frames.map((f) => `${f.type}:${f.subtype ?? f.type}`);
    expect(order.indexOf('system:compact_boundary')).toBeLessThan(
      order.indexOf('assistant:assistant'),
    );
  });

  it('trims an orphan toolResult at the kept boundary — its paired toolCall was pruned', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(compactionArgs());
    await drain(prepared.query('go'));
    const transform = captured.config?.transformContext;
    // A 700k-char assistant toolCall turn exceeds the ~629k-char target, so
    // the kept tail would open with an orphan toolResult — the transform must
    // trim it instead of forwarding a pair-broken transcript the provider
    // rejects.
    const transcript = [
      { role: 'user', content: 'x'.repeat(700_000), timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'y'.repeat(700_000) } },
        ],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: MODEL_ID,
        responseId: 'r1',
        usage: piUsage(),
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'search',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 3,
      },
      { role: 'user', content: 'current turn prompt', timestamp: 4 },
    ] as AgentMessage[];
    const transformed = (await transform?.(transcript)) ?? [];
    expect(transformed.some((m) => m.role === 'toolResult')).toBe(false);
    expect(transformed[0]).toMatchObject({ role: 'user', content: 'BOUNDED LEARNER CTX' });
    // The current-turn prompt is never dropped.
    expect(transformed.at(-1)).toMatchObject({ content: 'current turn prompt' });
  });

  it('counts CJK at ~1 token/char so a Chinese transcript still triggers compaction', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(compactionArgs());
    await drain(prepared.query('go'));
    const transform = captured.config?.transformContext;
    // 230_000 CJK chars: chars/4 would estimate ~57k tokens (22% of the
    // 262144 window — far under the 85% trigger) while the real tokenizer
    // lands near ~230k (~88%). Without the CJK-aware estimate compaction
    // never fires and the next provider request is rejected outright.
    const transcript = [
      { role: 'user', content: '题'.repeat(200_000), timestamp: 1 },
      { role: 'user', content: '答'.repeat(30_000), timestamp: 2 },
    ] as AgentMessage[];
    const transformed = (await transform?.(transcript)) ?? [];
    // Under chars/4 this passes through unchanged; the CJK estimate prunes
    // the 200k head and re-injects sessionContext first.
    expect(transformed[0]).toMatchObject({ role: 'user', content: 'BOUNDED LEARNER CTX' });
    expect(transformed.at(-1)).toMatchObject({ content: '答'.repeat(30_000) });
    expect(
      transformed.some((m) => (m as { content?: string }).content === '题'.repeat(200_000)),
    ).toBe(false);
  });

  it('never throws — a transformContext failure passes the original messages through', async () => {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(compactionArgs());
    await drain(prepared.query('go'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Token estimation iterates the message list inside the try — a hostile
    // container surfaces as warn + passthrough, never a paid-work abort.
    const hostile = new Proxy([] as AgentMessage[], {
      get: (target, prop) => {
        if (prop === Symbol.iterator) throw new Error('iteration exploded');
        return Reflect.get(target, prop);
      },
    });
    expect(await captured.config?.transformContext?.(hostile)).toBe(hostile);
    expect(warn).toHaveBeenCalledWith(
      '[pi-adapter] transformContext failed; passing context through',
      expect.objectContaining({ error: 'iteration exploded' }),
    );
    warn.mockRestore();
  });
});

describe('PiPreparedQuery — P3 hook bridge wiring', () => {
  const callCtx = {
    toolCall: { id: 'call_1', name: 'mcp__loom__read_mistakes' },
    args: { q: 'x' },
  } as never;

  async function captureConfig(args: ExecutionAdapterStartupArgs) {
    const captured: Partial<CapturedLoop> = {};
    const deps = makeDeps([{ type: 'agent_end', messages: [piAssistant()] }], captured);
    const adapter = new PiAgentAdapter(deps as never);
    const prepared = await adapter.startup(args);
    await drain(prepared.query('go'));
    return captured.config;
  }

  it('runs piHooks.beforeToolCall before options.canUseTool (SDK order)', async () => {
    const order: string[] = [];
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
      piHooks: {
        beforeToolCall: [
          async () => {
            order.push('piHook');
            return undefined;
          },
        ],
      },
    });
    args.options.hooks = { PreToolUse: [] } as never;
    args.options.canUseTool = async () => {
      order.push('canUseTool');
      return { behavior: 'allow' as const };
    };
    const config = await captureConfig(args);
    await config?.beforeToolCall?.(callCtx, undefined);
    expect(order).toEqual(['piHook', 'canUseTool']);
  });

  it('a blocking piHook short-circuits canUseTool entirely', async () => {
    const order: string[] = [];
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
      piHooks: {
        beforeToolCall: [
          () => {
            order.push('gate');
            return { block: true, reason: 'spawn denied by contract' };
          },
        ],
      },
    });
    args.options.hooks = { PreToolUse: [] } as never;
    args.options.canUseTool = async () => {
      order.push('canUseTool');
      return { behavior: 'allow' as const };
    };
    const config = await captureConfig(args);
    expect(await config?.beforeToolCall?.(callCtx, undefined)).toEqual({
      block: true,
      reason: 'spawn denied by contract',
    });
    expect(order).toEqual(['gate']);
  });

  it('hands the adapter abort signal to hooks when the loop passes none', async () => {
    let seenSignal: AbortSignal | undefined;
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
      piHooks: {
        beforeToolCall: [
          (_call, _args, sig) => {
            seenSignal = sig;
            return undefined;
          },
        ],
      },
    });
    args.options.hooks = { PreToolUse: [] } as never;
    const config = await captureConfig(args);
    await config?.beforeToolCall?.(callCtx, undefined);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('forwards settled results to afterToolCall observers with the merged override returned', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const args = startupArgs({
      kind: 'DreamingTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes')],
      piHooks: {
        afterToolCall: [
          async (obs) => {
            seen.push(obs as unknown as Record<string, unknown>);
            return { additionalContext: 'tool_use_id=call_1' } as never;
          },
          () => ({ blocked: false }) as never,
        ],
      },
    });
    args.options.hooks = { PostToolUse: [] } as never;
    const config = await captureConfig(args);
    const merged = await config?.afterToolCall?.(
      {
        toolCall: { id: 'call_1', name: 'mcp__loom__read_mistakes' },
        args: { q: 'x' },
        result: { content: [{ type: 'text', text: 'out' }] },
        isError: false,
      } as never,
      undefined,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      call: { id: 'call_1', name: 'mcp__loom__read_mistakes' },
      args: { q: 'x' },
      isError: false,
      output: [{ type: 'text', text: 'out' }],
    });
    expect(merged).toEqual({ additionalContext: 'tool_use_id=call_1', blocked: false });
  });
});

describe('PiPreparedQuery — P3 nested subagents (Task/Agent host)', () => {
  const SCOUT_PROMPT = 'SCOUT SYSTEM PROMPT — report only.';
  const scoutSpec = {
    description: 'read-only scout',
    prompt: SCOUT_PROMPT,
    tools: ['mcp__loom__read_mistakes'],
    maxTurns: 3,
  };
  const childAssistant = () =>
    piAssistant({
      content: [{ type: 'text', text: 'scout report body' }],
      usage: piUsage({
        input: 50,
        output: 20,
        totalTokens: 70,
        cost: { input: 0.03, output: 0.06, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      }),
    });

  function nestedStartup(
    childEvents: (ctx: {
      config: AgentLoopConfig;
      context: AgentContext;
      signal: AbortSignal | undefined;
    }) => AgentEvent[],
    beforeExecute?: () => void,
    childStreamFactory?: (ctx: {
      config: AgentLoopConfig;
      context: AgentContext;
      signal: AbortSignal | undefined;
    }) => EventStream<AgentEvent, AgentMessage[]>,
  ) {
    const childCalls: Array<{
      context: AgentContext;
      config: AgentLoopConfig;
      signal: AbortSignal | undefined;
    }> = [];
    const parentAssistant = piAssistant();
    const agentLoop = vi.fn(
      (
        _prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        _streamFn: StreamFn,
      ): EventStream<AgentEvent, AgentMessage[]> => {
        if (context.systemPrompt === SCOUT_PROMPT) {
          childCalls.push({ context, config, signal });
          return (
            childStreamFactory?.({ context, config, signal }) ??
            fakeStream(childEvents({ context, config, signal }))
          );
        }
        // Parent loop: drive the Task tool in-process exactly where the real
        // loop would execute the tool call, then surface its result.
        return (async function* () {
          const task = (context.tools ?? []).find((t) => t.name === 'Task');
          if (!task) throw new Error('Task tool not mounted');
          beforeExecute?.();
          let resultContent: unknown = 'unset';
          let isError = false;
          try {
            const res = await task.execute(
              'call_sub_1',
              { subagent_type: 'scout', description: 'recon', prompt: 'go scout' },
              signal,
            );
            resultContent = res.content;
          } catch (error) {
            isError = true;
            resultContent = [
              { type: 'text', text: error instanceof Error ? error.message : String(error) },
            ];
          }
          yield {
            type: 'message_end',
            message: piAssistant({
              content: [
                {
                  type: 'toolCall',
                  id: 'call_sub_1',
                  name: 'Task',
                  arguments: { subagent_type: 'scout' },
                },
              ],
            }),
          } as AgentEvent;
          yield {
            type: 'message_end',
            message: {
              role: 'toolResult',
              toolCallId: 'call_sub_1',
              toolName: 'Task',
              content: resultContent,
              isError,
              timestamp: 1_700_000_000_002,
            },
          } as AgentEvent;
          yield { type: 'message_end', message: parentAssistant } as AgentEvent;
          yield { type: 'agent_end', messages: [parentAssistant] } as AgentEvent;
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>;
      },
    );
    const deps = { ...makeDeps([]), agentLoop };
    const adapter = new PiAgentAdapter(deps as never);
    const args = startupArgs({
      kind: 'CopilotTask',
      piToolMounts: [customMount('mcp__loom__read_mistakes', 'mcp__loom__propose_knowledge')],
      piAgents: { scout: scoutSpec },
      // Queued-message surface is root-only — the child config assertions
      // below pin that nested loops never see it.
      piQueues: {
        getSteeringMessages: vi.fn(async () => []),
        getFollowUpMessages: vi.fn(async () => []),
      },
    });
    args.options.agents = {
      scout: { description: 'read-only scout', prompt: SCOUT_PROMPT },
    } as never;
    return { adapter, args, childCalls };
  }

  it('mounts Task/Agent on the parent and runs the child loop in-process with lifecycle frames + usage aggregation', async () => {
    const { adapter, args, childCalls } = nestedStartup(() => [
      { type: 'tool_execution_start', toolName: 'mcp__loom__read_mistakes' } as AgentEvent,
      { type: 'message_end', message: childAssistant() },
      { type: 'agent_end', messages: [childAssistant()] },
    ]);
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;

    // Parent sees both spawn aliases plus the domain tools; the child inherits
    // the spec's allowlist minus spawn names (depth-one is structural).
    expect(childCalls).toHaveLength(1);
    const child = childCalls[0];
    expect(child?.context.systemPrompt).toBe(SCOUT_PROMPT);
    expect(child?.context.tools?.map((t) => t.name)).toEqual(['mcp__loom__read_mistakes']);
    expect(child?.signal).toBeInstanceOf(AbortSignal);
    expect(child?.config.shouldStopAfterTurn).toBeTypeOf('function');
    // Steering/follow-up are root-loop surfaces — a synchronous child
    // execution must not drain a parent queue.
    expect(child?.config.getSteeringMessages).toBeUndefined();
    expect(child?.config.getFollowUpMessages).toBeUndefined();

    const subtypes = frames.map((f) => `${f.type}:${f.subtype ?? f.type}`);
    // init → task_started/task_progress/task_updated (drained before the
    // parent's tool-result frame) → assistant → user → assistant → result.
    expect(subtypes).toEqual([
      'system:init',
      'system:task_started',
      'system:task_progress',
      'system:task_updated',
      'assistant:assistant',
      'user:user',
      'assistant:assistant',
      'result:success',
    ]);
    expect(frames[1]).toMatchObject({
      task_id: 'call_sub_1',
      tool_use_id: 'call_sub_1',
      subagent_type: 'scout',
      description: 'recon',
    });
    expect(frames[2]).toMatchObject({
      task_id: 'call_sub_1',
      usage: { tool_uses: 1 },
      last_tool_name: 'mcp__loom__read_mistakes',
    });
    expect(frames[3]).toMatchObject({ task_id: 'call_sub_1', patch: { status: 'completed' } });

    // The child's report is the parent-visible tool result.
    const userFrame = frames[5];
    const toolResult = (
      userFrame?.message as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.[0];
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_sub_1',
      is_error: false,
      content: [{ type: 'text', text: 'scout report body' }],
    });

    // Terminal evidence aggregates the child's spend (SDK modelUsage parity).
    const result = frames[7];
    const usage = result?.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(120 + 50);
    expect(usage.output_tokens).toBe(45 + 20);
    expect(result?.total_cost_usd).toBeCloseTo(0.43);
    const modelUsage = result?.modelUsage as Record<string, Record<string, number>>;
    expect(modelUsage[MODEL_ID]?.inputTokens).toBe(170);
    expect(modelUsage[MODEL_ID]?.costUSD).toBeCloseTo(0.43);
  });

  it('marks the child task_updated failed and settles an error tool result when the child loop throws', async () => {
    const { adapter, args } = nestedStartup(() => {
      throw new Error('child loop exploded');
    });
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updated = frames.find((f) => f.subtype === 'task_updated');
    expect(updated).toMatchObject({
      task_id: 'call_sub_1',
      patch: { status: 'failed', error: 'child loop exploded' },
    });
    const userFrame = frames.find((f) => f.type === 'user');
    const toolResult = (
      userFrame?.message as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.[0];
    expect(toolResult).toMatchObject({ is_error: true });
  });

  it('marks the child killed and suppresses the parent terminal frame when the caller aborts before the spawn', async () => {
    // The caller aborts just before Task executes: the child's AbortSignal.any
    // lineage is already aborted, the child stream still drains (the fake loop
    // ignores signals), and the host's post-loop abort check reports killed.
    const { adapter, args } = nestedStartup(
      () => [
        { type: 'message_end', message: childAssistant() },
        { type: 'agent_end', messages: [childAssistant()] },
      ],
      () => (argsRef.options.abortController as AbortController).abort(),
    );
    const argsRef = args;
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updated = frames.find((f) => f.subtype === 'task_updated');
    expect(updated).toMatchObject({ task_id: 'call_sub_1', patch: { status: 'killed' } });
    // Caller abort owns the terminal truth — no synthesized success result.
    expect(frames.find((f) => f.type === 'result')).toBeUndefined();
  });

  it('marks the child failed when the provider ends with no assistant message at all', async () => {
    // Root-loop parity: agent_end without an assistant is
    // error_during_execution at the root, so the child cannot be completed
    // either — the parent would quote a report that was never written.
    const { adapter, args } = nestedStartup(() => [{ type: 'agent_end', messages: [] }]);
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updated = frames.find((f) => f.subtype === 'task_updated');
    expect(updated).toMatchObject({
      task_id: 'call_sub_1',
      patch: {
        status: 'failed',
        error: expect.stringContaining('without an assistant message'),
      },
    });
    const userFrame = frames.find((f) => f.type === 'user');
    const toolResult = (
      userFrame?.message as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.[0];
    expect(toolResult).toMatchObject({ is_error: true });
  });

  it('marks the child failed when it exhausts spec.maxTurns (ADR-0056 fail-closed)', async () => {
    // The real loop calls shouldStopAfterTurn after each completed turn;
    // maxTurns=3 ends the child mid-investigation. A capped child must not
    // surface as completed with a placeholder report.
    const { adapter, args } = nestedStartup(
      () => [],
      undefined,
      ({ config }) =>
        (async function* () {
          const assistant = childAssistant();
          for (let turn = 0; turn < 4; turn++) {
            yield { type: 'message_end', message: assistant } as AgentEvent;
            if (await config.shouldStopAfterTurn?.({} as never)) break;
          }
          yield { type: 'agent_end', messages: [assistant] } as AgentEvent;
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>,
    );
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updated = frames.find((f) => f.subtype === 'task_updated');
    expect(updated).toMatchObject({
      task_id: 'call_sub_1',
      patch: { status: 'failed', error: expect.stringContaining('turn ceiling') },
    });
    const userFrame = frames.find((f) => f.type === 'user');
    const toolResult = (
      userFrame?.message as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.[0];
    expect(toolResult).toMatchObject({ is_error: true });
  });

  it('marks the child failed when the provider ends its stream with stopReason error (root-loop parity)', async () => {
    // A child that ends error/aborted without the caller's abort must not be
    // reported completed — the parent would answer from a nonexistent report.
    const { adapter, args } = nestedStartup(() => [
      {
        type: 'agent_end',
        messages: [
          {
            ...childAssistant(),
            stopReason: 'error',
            errorMessage: 'provider blew up mid-child',
          },
        ],
      },
    ]);
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updated = frames.find((f) => f.subtype === 'task_updated');
    expect(updated).toMatchObject({
      task_id: 'call_sub_1',
      patch: { status: 'failed', error: 'provider blew up mid-child' },
    });
    const userFrame = frames.find((f) => f.type === 'user');
    const toolResult = (
      userFrame?.message as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.[0];
    expect(toolResult).toMatchObject({ is_error: true });
  });

  it('marks the child killed exactly once when the aborted child stream throws mid-iteration', async () => {
    // An aborted child may end its stream quietly OR throw the abort — both
    // paths must close the durable task_* row with a single killed frame.
    const { adapter, args } = nestedStartup(
      () => [],
      () => (args.options.abortController as AbortController).abort(),
      () =>
        (async function* () {
          if (Date.now() >= 0) throw new Error('stream aborted mid-iteration');
          yield { type: 'turn_start' };
        })() as unknown as EventStream<AgentEvent, AgentMessage[]>,
    );
    const prepared = await adapter.startup(args);
    const frames = (await drain(prepared.query('go'))) as Array<Record<string, unknown>>;
    const updatedFrames = frames.filter((f) => f.subtype === 'task_updated');
    expect(updatedFrames).toHaveLength(1);
    expect(updatedFrames[0]).toMatchObject({
      task_id: 'call_sub_1',
      patch: { status: 'killed' },
    });
    expect(frames.find((f) => f.type === 'result')).toBeUndefined();
  });
});
