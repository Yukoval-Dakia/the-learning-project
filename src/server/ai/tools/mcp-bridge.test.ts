import { capabilities } from '@/capabilities';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerCapabilityTools } from './register-capability-tools';
import { __resetRegistryForTests, registerTool } from './registry';

// Mock the SDK so the bridge can run without a Claude subprocess.
const mockAgentSdk = vi.hoisted(() => ({
  capturedServerOptions: undefined as unknown,
  toolDefs: [] as Array<{
    name: string;
    description: string;
    schema: unknown;
    handler: (args: unknown) => Promise<unknown>;
  }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => {
    mockAgentSdk.capturedServerOptions = opts;
    return { type: 'sdk', instance: opts };
  }),
  tool: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => {
    const def = { name, description, schema, handler } as (typeof mockAgentSdk.toolDefs)[number];
    mockAgentSdk.toolDefs.push(def);
    return def;
  }),
}));

// Mock writeToolCallLog / setToolCallLogMirroredEventId — bridge calls them
// but unit tests just need to capture invocations.
const captured = vi.hoisted(() => ({
  toolCallLogs: [] as unknown[],
  mirroredLinks: [] as Array<{ tcl_id: string; event_id: string }>,
  events: [] as unknown[],
}));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: vi.fn(async (_db: unknown, entry: unknown) => {
    captured.toolCallLogs.push(entry);
    return 'mock_tcl_id';
  }),
  setToolCallLogMirroredEventId: vi.fn(async (_db: unknown, tcl_id: string, event_id: string) => {
    captured.mirroredLinks.push({ tcl_id, event_id });
  }),
}));

// Mock writeEvent — Lane D's mirror writer. Unit test asserts the input
// shape; full Zod validation is exercised by the db-level integration test.
vi.mock('@/kernel/events', () => ({
  writeEvent: vi.fn(async (_db: unknown, input: unknown) => {
    captured.events.push(input);
    return (input as { id: string }).id;
  }),
}));

import {
  __resolveMirrorPolicy,
  buildMcpServerFromRegistry,
  shouldEmitToolUseForCaller,
} from './mcp-bridge';

function makeReadTool<I, O>(
  name: string,
  inputShape: Record<string, z.ZodTypeAny>,
  runFn: (input: I) => O,
  summarizeFn: (input: I, output: O) => string,
): DomainTool<I, O> {
  return {
    name,
    description: `Tool ${name}`,
    effect: 'read',
    inputSchema: z.object(inputShape) as unknown as z.ZodType<I>,
    outputSchema: z.unknown() as z.ZodType<O>,
    costClass: 'local',
    async execute(_ctx, input) {
      return runFn(input);
    },
    summarize: summarizeFn,
    mirrorEvent: 'when_user_visible',
  };
}

const ctx: ToolContext = {
  db: {} as never,
  taskRunId: 'tr_test',
  callerActor: { kind: 'agent', ref: 'agent:test:bridge' },
};

describe('buildMcpServerFromRegistry', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    mockAgentSdk.capturedServerOptions = undefined;
    mockAgentSdk.toolDefs = [];
    captured.toolCallLogs = [];
    captured.mirroredLinks = [];
    captured.events = [];
  });

  it('wraps each toolName into an SDK tool with the inputSchema raw shape', () => {
    registerTool(
      makeReadTool<{ q: string }, { hits: number }>(
        'demo_a',
        { q: z.string() },
        (i) => ({ hits: i.q.length }),
        (i, o) => `demo_a · ${i.q} → ${o.hits}`,
      ),
    );
    registerTool(
      makeReadTool<{ k: string }, { ok: true }>(
        'demo_b',
        { k: z.string() },
        () => ({ ok: true }),
        () => 'demo_b ok',
      ),
    );

    buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['demo_a', 'demo_b'] });

    const server = mockAgentSdk.capturedServerOptions as { name: string };
    expect(server.name).toBe('loom_v2');
    expect(mockAgentSdk.toolDefs.map((t) => t.name)).toEqual(['demo_a', 'demo_b']);
    // Raw shape, not a ZodObject — SDK contract.
    expect((mockAgentSdk.toolDefs[0].schema as Record<string, unknown>).q).toBeDefined();
  });

  it('constructs the production MCP server with run_task and query_events included', async () => {
    await registerCapabilityTools(capabilities);

    expect(() =>
      buildMcpServerFromRegistry({
        ctx,
        serverName: 'loom_v2',
        toolNames: ['run_task', 'query_events'],
      }),
    ).not.toThrow();
    expect(mockAgentSdk.toolDefs.map((tool) => tool.name)).toEqual(['run_task', 'query_events']);
    const runTaskSchema = mockAgentSdk.toolDefs[0].schema as Record<string, unknown>;
    expect(runTaskSchema.task_kind).toBeDefined();
    expect(runTaskSchema.intent).toBeDefined();
    const queryEventsSchema = mockAgentSdk.toolDefs[1].schema as Record<string, unknown>;
    expect(queryEventsSchema.filter).toBeDefined();
    expect(queryEventsSchema.cursor).toBeDefined();
  });

  it('handler invokes tool + writes tool_call_log + returns MCP content shape', async () => {
    const observedResults: unknown[] = [];
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_x',
        { q: z.string() },
        (i) => ({ len: i.q.length }),
        (i, o) => `demo_x · ${i.q.length} → ${o.len}`,
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_x'],
      onResult: (result) => {
        observedResults.push(result);
      },
    });
    const def = mockAgentSdk.toolDefs[0];
    const result = (await def.handler({ q: 'hello' })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary).toContain('demo_x');
    expect(parsed.output.len).toBe(5);

    expect(captured.toolCallLogs).toHaveLength(1);
    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.tool_name).toBe('demo_x');
    expect(log.effect).toBe('read');
    expect(log.error_reason).toBeUndefined();
    expect(observedResults).toEqual([
      {
        name: 'demo_x',
        effect: 'read',
        input: { q: 'hello' },
        output: { len: 5 },
        error_reason: null,
        executed: true,
      },
    ]);
  });

  it('binds proposal calls to a server-owned FULL owner gate instead of model prose', async () => {
    registerTool({
      name: 'demo_proposal',
      description: 'Propose a scoped change.',
      effect: 'propose',
      inputSchema: z.object({ target_id: z.string() }),
      outputSchema: z.object({ status: z.literal('proposed') }),
      costClass: 'local',
      async execute() {
        return { status: 'proposed' as const };
      },
      summarize() {
        return 'proposal recorded';
      },
      mirrorEvent: 'when_causal',
    });

    buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['demo_proposal'] });

    const result = (await mockAgentSdk.toolDefs[0]?.handler({ target_id: 'node_b' })) as {
      content: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;

    expect(parsed.proposal_effect_contract).toEqual({
      owner_gate: 'FULL',
      direct_write: false,
      rollback: 'dismiss_before_accept',
    });
  });

  it('lets callers block execution before a DomainTool runs', async () => {
    const runFn = vi.fn((i: { q: string }) => ({ len: i.q.length }));
    const beforeExecute = vi.fn(() => 'quota exceeded');
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_gate',
        { q: z.string() },
        runFn,
        () => 'should not be summarized',
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_gate'],
      beforeExecute,
    });
    const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'hello' })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(beforeExecute).toHaveBeenCalledWith({ name: 'demo_gate', effect: 'read' });
    expect(runFn).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('quota exceeded');

    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.error_reason).toBe('quota exceeded');
    expect(log.output_json).toEqual({ error: 'quota exceeded' });
  });

  it('awaits an async cancellation gate before starting a complex DomainTool', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const runFn = vi.fn((_i: { answer_ids: string[]; transfer_count: number }) => ({
      validated_probes: 6,
      source_documents: 3,
    }));
    registerTool(
      makeReadTool<
        { answer_ids: string[]; transfer_count: number },
        { validated_probes: number; source_documents: number }
      >(
        'demo_async_cancel_gate',
        { answer_ids: z.array(z.string()), transfer_count: z.number().int() },
        runFn,
        (_input, output) => `validated ${output.validated_probes} probes`,
      ),
    );
    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_async_cancel_gate'],
      beforeExecute: async () => {
        await gate;
        return undefined;
      },
    });

    const execution = mockAgentSdk.toolDefs[0].handler({
      answer_ids: Array.from({ length: 48 }, (_, index) => `answer_${index + 1}`),
      transfer_count: 9,
    });
    await Promise.resolve();
    expect(runFn).not.toHaveBeenCalled();

    releaseGate();
    await execution;
    expect(runFn).toHaveBeenCalledTimes(1);
  });

  it('captures an async cancellation-gate rejection without executing the tool', async () => {
    const runFn = vi.fn(() => ({ created: true }));
    registerTool(
      makeReadTool<{ prompt: string }, { created: boolean }>(
        'demo_async_cancel_rejection',
        { prompt: z.string() },
        runFn,
        () => 'should not execute',
      ),
    );
    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_async_cancel_rejection'],
      beforeExecute: async () => {
        throw new Error('cancel-state query lost');
      },
    });

    const result = (await mockAgentSdk.toolDefs[0].handler({
      prompt: 'author three linked artifacts from nine transfer variants',
    })) as { content: Array<{ text: string }> };

    expect(runFn).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).error).toBe('cancel-state query lost');
    expect(captured.toolCallLogs[0]).toMatchObject({ error_reason: 'cancel-state query lost' });
  });

  it('holds the execution barrier through tool logging and event mirroring', async () => {
    const observations: string[] = [];
    const runFn = vi.fn((_i: { prompt: string }) => {
      observations.push('execute');
      return { question_id: 'question_parameter_transfer_9' };
    });
    registerTool(
      makeReadTool<{ prompt: string }, { question_id: string }>(
        'demo_barrier',
        { prompt: z.string() },
        runFn,
        (_input, output) => `authored ${output.question_id}`,
      ),
    );
    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_barrier'],
      onExecuteStart: () => {
        observations.push('start');
      },
      onExecuteSettled: () => {
        expect(captured.toolCallLogs).toHaveLength(1);
        expect(captured.events).toHaveLength(1);
        observations.push('settled');
      },
    });

    await mockAgentSdk.toolDefs[0].handler({
      prompt: 'construct a unique-solution transfer item with dimensional validation',
    });

    expect(observations).toEqual(['start', 'execute', 'settled']);
  });

  // P5.1 / YUK-143 + YUK-290 — interceptInput merges context_budget into both
  // the agent output and persisted tool-call log (warning observability seam).
  it('interceptInput rewrites the executed args and merges context_budget into output', async () => {
    const runFn = vi.fn((i: { limit: number }) => ({ rows: i.limit }));
    const observedResults: unknown[] = [];
    registerTool(
      makeReadTool<{ limit: number }, { rows: number }>(
        'demo_capped',
        { limit: z.number() },
        runFn,
        (_i, o) => `demo_capped · ${o.rows}`,
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_capped'],
      interceptInput: (_tool, args) => ({
        args: { ...(args as object), limit: 3 },
        truncationNote: { applied_limit: 3, requested_limit: 10, truncated: true },
      }),
      onResult: (result) => {
        observedResults.push(result);
      },
    });
    const result = (await mockAgentSdk.toolDefs[0].handler({ limit: 10 })) as {
      content: Array<{ type: string; text: string }>;
    };

    // execute saw the capped limit (3), not the requested 10.
    expect(runFn).toHaveBeenCalledWith({ limit: 3 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.output.rows).toBe(3);
    expect(parsed.output.context_budget).toEqual({
      applied_limit: 3,
      requested_limit: 10,
      truncated: true,
    });
    // The agent-visible mirror/log args record the ORIGINAL request (10).
    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect((log.input_json as { limit: number }).limit).toBe(10);
    expect(log.output_json).toMatchObject({
      context_budget: { applied_limit: 3, requested_limit: 10, truncated: true },
    });
    // YUK-832 review sees the exact executed input and agent-visible typed
    // output, while the authority log intentionally retains the original ask.
    expect(observedResults).toEqual([
      {
        name: 'demo_capped',
        effect: 'read',
        input: { limit: 3 },
        output: {
          rows: 3,
          context_budget: { applied_limit: 3, requested_limit: 10, truncated: true },
        },
        error_reason: null,
        executed: true,
      },
    ]);
  });

  it('does not turn a completed tool into a failure when the result observer throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerTool(
      makeReadTool<{ subject_id: string }, { events: Array<{ id: string }>; has_more: false }>(
        'demo_observer_failure',
        { subject_id: z.string() },
        () => ({ events: [{ id: 'evt_observer_01' }], has_more: false }),
        () => 'one exact event',
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_observer_failure'],
      onResult: () => {
        throw new Error('review buffer unavailable');
      },
    });

    const result = (await mockAgentSdk.toolDefs[0].handler({
      subject_id: 'diagnostic_subject_observer_failure',
    })) as { content: Array<{ text: string }> };

    expect(JSON.parse(result.content[0].text).output).toEqual({
      events: [{ id: 'evt_observer_01' }],
      has_more: false,
    });
    expect(captured.toolCallLogs[0]).toMatchObject({ error_reason: undefined });
    expect(consoleError).toHaveBeenCalledWith(
      '[mcp-bridge] onResult failed',
      expect.objectContaining({ tool: 'demo_observer_failure', task_run_id: 'tr_test' }),
    );
  });

  // P5.1 / YUK-143 FIX 1 — budget-exhaustion soft-stop. When interceptInput
  // returns a `softStop` reason (instead of capped args), the bridge must NOT
  // execute the tool and must surface the string as the tool result — exactly
  // like a beforeExecute gate. This guards the spec's central "never a hard
  // reject/throw" invariant: the tool is never run with a limit:0 that would
  // trip its own Zod min.
  it('interceptInput softStop short-circuits execute and surfaces the reason as the tool result', async () => {
    const runFn = vi.fn((_i: { limit: number }) => ({ rows: 0 }));
    registerTool(
      makeReadTool<{ limit: number }, { rows: number }>(
        'demo_exhausted',
        // min(1) mirrors the real budgeted readers: a limit:0 here would throw.
        { limit: z.number().int().min(1) },
        runFn,
        (_i, o) => `demo_exhausted · ${o.rows}`,
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_exhausted'],
      interceptInput: (_tool, _args) => ({
        args: _args,
        softStop:
          'context budget exhausted (eventRows); stop calling read tools and answer with what you have',
      }),
    });

    // No throw — handler resolves with a normal MCP content shape.
    const result = (await mockAgentSdk.toolDefs[0].handler({ limit: 20 })) as {
      content: Array<{ type: string; text: string }>;
    };

    // The tool was NOT executed (no limit:0 reached it → no Zod throw).
    expect(runFn).not.toHaveBeenCalled();
    // The soft-stop reason is surfaced as the tool result error, just like a
    // beforeExecute gate reason.
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/context budget exhausted \(eventRows\)/);
    expect(parsed.output).toBeUndefined();
    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.error_reason).toMatch(/context budget exhausted/);
  });

  it('interceptInput does not run when beforeExecute blocks the call', async () => {
    const runFn = vi.fn(() => ({ ok: true }));
    const interceptInput = vi.fn((_tool: unknown, args: unknown) => ({ args }));
    registerTool(
      makeReadTool<{ q: string }, { ok: boolean }>(
        'demo_blocked_then_intercept',
        { q: z.string() },
        runFn,
        () => 'blocked',
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_blocked_then_intercept'],
      beforeExecute: () => 'budget reached',
      interceptInput,
    });
    await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

    expect(interceptInput).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });

  it('records beforeExecute failures instead of escaping the handler', async () => {
    const runFn = vi.fn((i: { q: string }) => ({ len: i.q.length }));
    const beforeExecute = vi.fn(() => {
      throw new Error('gate exploded');
    });
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_gate_throw',
        { q: z.string() },
        runFn,
        () => 'should not be summarized',
      ),
    );

    buildMcpServerFromRegistry({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_gate_throw'],
      beforeExecute,
    });
    const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'hello' })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(runFn).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('gate exploded');

    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.tool_name).toBe('demo_gate_throw');
    expect(log.error_reason).toBe('gate exploded');
    expect(log.output_json).toEqual({ error: 'gate exploded' });
  });

  it('keeps successful execution successful when summarize throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_summary_err',
        { q: z.string() },
        (i) => ({ len: i.q.length }),
        () => {
          throw new Error('summary exploded');
        },
      ),
    );

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_summary_err'],
    });
    const def = mockAgentSdk.toolDefs[0];
    const result = (await def.handler({ q: 'hi' })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output.len).toBe(2);
    expect(parsed.summary).toContain('summary unavailable: summary exploded');

    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.error_reason).toBeUndefined();
    expect(log.output_json).toEqual({ len: 2 });

    const ev = captured.events[0] as Record<string, unknown>;
    expect(ev.outcome).toBe('success');
    expect(consoleError).toHaveBeenCalledWith(
      '[mcp-bridge] tool summarize failed',
      expect.objectContaining({ tool: 'demo_summary_err', task_run_id: 'tr_test' }),
    );
    consoleError.mockRestore();
  });

  it('captures hard-fail in tool_call_log error_reason without crashing the loop', async () => {
    registerTool(
      makeReadTool<{ q: string }, never>(
        'demo_err',
        { q: z.string() },
        () => {
          throw new Error('boom');
        },
        () => 'should not be called',
      ),
    );

    buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['demo_err'] });
    const def = mockAgentSdk.toolDefs[0];
    const result = (await def.handler({ q: 'x' })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('boom');
    expect(parsed.summary).toContain('error');

    expect(captured.toolCallLogs).toHaveLength(1);
    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.tool_name).toBe('demo_err');
    expect(log.error_reason).toBe('boom');
  });

  it('throws when a requested tool is not registered', () => {
    expect(() =>
      buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['nope'] }),
    ).toThrow(/not registered/);
  });

  it('writes tool_use mirror when caller is agent + policy fires', async () => {
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_mirror_ok',
        { q: z.string() },
        (i) => ({ len: i.q.length }),
        (i, o) => `demo_mirror_ok · ${i.q} → ${o.len}`,
      ),
    );

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_mirror_ok'],
    });
    const def = mockAgentSdk.toolDefs[0];
    await def.handler({ q: 'hi' });

    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0] as Record<string, unknown>;
    expect(ev.action).toBe('tool_use');
    expect(ev.actor_kind).toBe('agent');
    expect(ev.actor_ref).toBe('agent:copilot');
    expect(ev.subject_kind).toBe('query');
    expect((ev.subject_id as string).startsWith('tool_use_')).toBe(true);
    expect(ev.outcome).toBe('success');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.tool_name).toBe('demo_mirror_ok');
    expect((payload.args as Record<string, unknown>).q).toBe('hi');
    expect(payload.result_summary).toContain('demo_mirror_ok');

    expect(captured.mirroredLinks).toHaveLength(1);
    expect(captured.mirroredLinks[0].event_id).toBe(ev.id);
  });

  it('mirrors hard-fail with outcome=failure + error_reason', async () => {
    registerTool(
      makeReadTool<{ q: string }, never>(
        'demo_mirror_err',
        { q: z.string() },
        () => {
          throw new Error('boom');
        },
        () => 'should not be called',
      ),
    );

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_mirror_err'],
    });
    const def = mockAgentSdk.toolDefs[0];
    await def.handler({ q: 'x' });

    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0] as Record<string, unknown>;
    expect(ev.outcome).toBe('failure');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.error_reason).toBe('boom');
  });

  it('skips mirror when caller is user (schema requires actor_kind=agent)', async () => {
    registerTool(
      makeReadTool<{ q: string }, { ok: true }>(
        'demo_no_mirror_user',
        { q: z.string() },
        () => ({ ok: true }),
        () => 'demo_no_mirror_user',
      ),
    );

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'user', ref: 'self' } },
      serverName: 'loom_v2',
      toolNames: ['demo_no_mirror_user'],
    });
    await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

    expect(captured.events).toHaveLength(0);
    expect(captured.toolCallLogs).toHaveLength(1); // tcl still written
  });

  it('skips mirror when policy=never even for agent caller', async () => {
    const t = makeReadTool<{ q: string }, { ok: true }>(
      'demo_never',
      { q: z.string() },
      () => ({ ok: true }),
      () => 'demo_never',
    );
    t.mirrorEvent = 'never';
    registerTool(t);

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_never'],
    });
    await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

    expect(captured.events).toHaveLength(0);
  });

  // YUK-457 — live/replay-same-rows invariant: onToolComplete (the live
  // tool_result SSE card) must fire iff the same mirror-policy resolution
  // that persists the tool_use mirror fires. A never-mirror tool must not
  // emit a live card that vanishes on refresh.
  it('skips onToolComplete for a never-mirror tool even for an agent copilot caller', async () => {
    const t = makeReadTool<{ q: string }, { ok: boolean }>(
      'demo_complete_never',
      { q: z.string() },
      () => ({ ok: true }),
      () => 'demo_complete_never ok',
    );
    t.mirrorEvent = 'never';
    registerTool(t);
    const onToolComplete = vi.fn();

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_complete_never'],
      onToolComplete,
    });
    await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

    expect(onToolComplete).not.toHaveBeenCalled();
    // Same decision, same call: no persisted mirror either.
    expect(captured.events).toHaveLength(0);
    // The tool still ran and logged — the gate is visibility-only.
    expect(captured.toolCallLogs).toHaveLength(1);
  });

  it('fires onToolComplete for a mirrored when_user_visible tool call', async () => {
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_complete_uv',
        { q: z.string() },
        (i) => ({ len: i.q.length }),
        (i, o) => `demo_complete_uv · ${i.q} → ${o.len}`,
      ),
    );
    const onToolComplete = vi.fn();

    buildMcpServerFromRegistry({
      ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom_v2',
      toolNames: ['demo_complete_uv'],
      onToolComplete,
    });
    await mockAgentSdk.toolDefs[0].handler({ q: 'hello' });

    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(onToolComplete).toHaveBeenCalledWith({
      toolName: 'demo_complete_uv',
      input: { q: 'hello' },
      summary: 'demo_complete_uv · hello → 5',
    });
    expect(captured.events).toHaveLength(1);
  });

  // YUK-862 / F3.1 — output schema enforcement tests
  describe('output schema enforcement', () => {
    it('rejects invalid primitive output with error_reason=output_schema_invalid and no success result', async () => {
      const settled: string[] = [];
      registerTool({
        name: 'bad_primitive_output',
        description: 'returns wrong type',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return 'not an object' as unknown as { hits: number };
        },
        summarize() {
          return 'should not be called';
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({
        ctx,
        serverName: 'loom_v2',
        toolNames: ['bad_primitive_output'],
        onExecuteSettled: () => {
          settled.push('settled');
        },
      });
      const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/output_schema_invalid/);
      expect(parsed.output).toBeUndefined();
      // onExecuteSettled must run exactly once even on schema failure
      expect(settled).toEqual(['settled']);
      // tool_call_log must record the failure
      const log = captured.toolCallLogs[0] as Record<string, unknown>;
      expect(log.error_reason).toMatch(/output_schema_invalid/);
    });

    it('rejects object output with unknown key when schema uses strict()', async () => {
      registerTool({
        name: 'strict_output',
        description: 'strict schema rejects extra keys',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }).strict(),
        costClass: 'local',
        async execute() {
          return { hits: 5, extra: 'not allowed' } as unknown as { hits: number };
        },
        summarize() {
          return 'should not be called';
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['strict_output'] });
      const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/output_schema_invalid/);
      expect(parsed.output).toBeUndefined();
    });

    it('uses the parsed (transformed) output when schema applies transforms', async () => {
      registerTool({
        name: 'transformed_output',
        description: 'schema coerces and transforms output',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.coerce.number() }),
        costClass: 'local',
        async execute() {
          return { hits: '42' } as unknown as { hits: number };
        },
        summarize(_input, output) {
          return `hits=${output.hits}`;
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['transformed_output'] });
      const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      // parsed output must use the coerced number, not the raw string
      expect(parsed.output?.hits).toBe(42);
      expect(parsed.error).toBeUndefined();
      const log = captured.toolCallLogs[0] as Record<string, unknown>;
      expect(log.error_reason).toBeUndefined();
      expect((log.output_json as Record<string, unknown>).hits).toBe(42);
    });

    it('records output_schema_invalid in log and mirror even when onResult throws', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      registerTool({
        name: 'invalid_output_observer_fails',
        description: 'invalid output + failing observer',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return 'wrong' as unknown as { hits: number };
        },
        summarize() {
          return '';
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({
        ctx,
        serverName: 'loom_v2',
        toolNames: ['invalid_output_observer_fails'],
        onResult: () => {
          throw new Error('observer exploded');
        },
      });
      const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/output_schema_invalid/);
      // observer failure must not escalate to SDK
      expect(parsed.output).toBeUndefined();
      const log = captured.toolCallLogs[0] as Record<string, unknown>;
      expect(log.error_reason).toMatch(/output_schema_invalid/);
      consoleError.mockRestore();
    });

    it('releases barrier (onExecuteSettled runs once) on output_schema_invalid', async () => {
      const settledCalls: string[] = [];
      registerTool({
        name: 'schema_fail_barrier',
        description: 'verify barrier released on schema failure',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return null as unknown as { hits: number };
        },
        summarize() {
          return '';
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({
        ctx,
        serverName: 'loom_v2',
        toolNames: ['schema_fail_barrier'],
        onExecuteSettled: () => {
          settledCalls.push('released');
        },
      });
      await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

      expect(settledCalls).toHaveLength(1);
      expect(settledCalls[0]).toBe('released');
    });

    it('writes failure mirror with error_reason on output_schema_invalid when policy fires', async () => {
      registerTool({
        name: 'schema_fail_mirror',
        description: 'failure mirror on schema rejection',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return 'bad' as unknown as { hits: number };
        },
        summarize() {
          return '';
        },
        mirrorEvent: 'always',
      });

      buildMcpServerFromRegistry({
        ctx: { ...ctx, callerActor: { kind: 'agent', ref: 'agent:copilot' } },
        serverName: 'loom_v2',
        toolNames: ['schema_fail_mirror'],
      });
      await mockAgentSdk.toolDefs[0].handler({ q: 'x' });

      const log = captured.toolCallLogs[0] as Record<string, unknown>;
      expect(log.error_reason).toMatch(/output_schema_invalid/);
      expect(log.output_json).toEqual(
        expect.objectContaining({ error: expect.stringMatching(/output_schema_invalid/) }),
      );
      expect(captured.events).toHaveLength(1);
      const ev = captured.events[0] as Record<string, unknown>;
      expect(ev.outcome).toBe('failure');
      const payload = ev.payload as Record<string, unknown>;
      expect(payload.error_reason).toMatch(/output_schema_invalid/);
    });

    it('redacts actual values — error message contains only paths, not field values', async () => {
      registerTool({
        name: 'redact_check',
        description: 'verify values are not leaked in error',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return { hits: 'SECRET_VALUE_MUST_NOT_APPEAR' } as unknown as { hits: number };
        },
        summarize() {
          return '';
        },
        mirrorEvent: 'never',
      });

      buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['redact_check'] });
      const result = (await mockAgentSdk.toolDefs[0].handler({ q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).not.toContain('SECRET_VALUE_MUST_NOT_APPEAR');
      expect(parsed.error).toMatch(/hits/);
    });
  });

  it('throws when a tool inputSchema is not a z.object', () => {
    const badTool: DomainTool<unknown, unknown> = {
      name: 'bad_schema',
      description: 'invalid',
      effect: 'read',
      inputSchema: z.string() as unknown as z.ZodType<unknown>,
      outputSchema: z.unknown(),
      costClass: 'local',
      async execute() {
        return null;
      },
      summarize() {
        return '';
      },
      mirrorEvent: 'never',
    };
    registerTool(badTool);
    expect(() =>
      buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['bad_schema'] }),
    ).toThrow(/must be a z\.object/);
  });
});

describe('__resolveMirrorPolicy', () => {
  it('returns false for non-agent callers', () => {
    expect(__resolveMirrorPolicy('always', { kind: 'user', ref: 'self' }, 'read')).toBe(false);
    expect(__resolveMirrorPolicy('always', { kind: 'cron', ref: 'cron:x' }, 'read')).toBe(false);
    expect(__resolveMirrorPolicy('always', { kind: 'system', ref: 'sys' }, 'read')).toBe(false);
  });

  it('always fires for agent callers when policy=always', () => {
    expect(__resolveMirrorPolicy('always', { kind: 'agent', ref: 'agent:x' }, 'read')).toBe(true);
  });

  it('never fires when policy=never', () => {
    expect(__resolveMirrorPolicy('never', { kind: 'agent', ref: 'agent:copilot' }, 'read')).toBe(
      false,
    );
  });

  it('when_user_visible: accepts prefixed and bare copilot / teaching agent refs', () => {
    expect(
      __resolveMirrorPolicy('when_user_visible', { kind: 'agent', ref: 'agent:copilot' }, 'read'),
    ).toBe(true);
    expect(
      __resolveMirrorPolicy('when_user_visible', { kind: 'agent', ref: 'copilot' }, 'read'),
    ).toBe(true);
    expect(
      __resolveMirrorPolicy(
        'when_user_visible',
        { kind: 'agent', ref: 'agent:teaching:active' },
        'read',
      ),
    ).toBe(true);
    expect(
      __resolveMirrorPolicy('when_user_visible', { kind: 'agent', ref: 'teaching:active' }, 'read'),
    ).toBe(true);
    expect(
      __resolveMirrorPolicy('when_user_visible', { kind: 'agent', ref: 'agent:dreaming' }, 'read'),
    ).toBe(false);
  });

  it('when_causal: prefixed or bare dreaming OR propose/write effect', () => {
    expect(
      __resolveMirrorPolicy(
        'when_causal',
        { kind: 'agent', ref: 'agent:dreaming:variant' },
        'read',
      ),
    ).toBe(true);
    expect(__resolveMirrorPolicy('when_causal', { kind: 'agent', ref: 'dreaming' }, 'read')).toBe(
      true,
    );
    expect(
      __resolveMirrorPolicy('when_causal', { kind: 'agent', ref: 'agent:misc' }, 'propose'),
    ).toBe(true);
    expect(
      __resolveMirrorPolicy('when_causal', { kind: 'agent', ref: 'agent:misc' }, 'write'),
    ).toBe(true);
    expect(__resolveMirrorPolicy('when_causal', { kind: 'agent', ref: 'agent:misc' }, 'read')).toBe(
      false,
    );
  });
});

describe('shouldEmitToolUseForCaller — live tool_use gate (YUK-457)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('drops registry tools whose mirror policy does not fire for the caller', async () => {
    await registerCapabilityTools(capabilities);
    const copilot = { kind: 'agent', ref: 'agent:copilot' } as const;

    // 'never' policy: internal retrieval must not open a live card.
    expect(shouldEmitToolUseForCaller('mcp__loom__search_memory_facts', 'loom', copilot)).toBe(
      false,
    );
    expect(shouldEmitToolUseForCaller('mcp__loom__query_questions', 'loom', copilot)).toBe(false);
    // when_user_visible + copilot caller → mirrored → live card.
    expect(shouldEmitToolUseForCaller('mcp__loom__query_mistakes', 'loom', copilot)).toBe(true);
  });

  it('applies caller-dependent policies, not just the declared mirrorEvent', async () => {
    await registerCapabilityTools(capabilities);
    // when_user_visible resolves false for a dreaming caller: same live/replay
    // decision as the persisted mirror would make.
    expect(
      shouldEmitToolUseForCaller('mcp__loom__query_mistakes', 'loom', {
        kind: 'agent',
        ref: 'agent:dreaming',
      }),
    ).toBe(false);
  });

  it('passes through non-registry names (native Task, remote MCP) and unregistered suffixes', () => {
    const copilot = { kind: 'agent', ref: 'agent:copilot' } as const;
    // Task is dropped later by the SSE sanitizer; Tavily cards are governed by
    // the finalize force-done ruling — the gate must not touch either.
    expect(shouldEmitToolUseForCaller('Task', 'loom', copilot)).toBe(true);
    expect(shouldEmitToolUseForCaller('mcp__tavily__tavily-search', 'loom', copilot)).toBe(true);
    expect(shouldEmitToolUseForCaller('mcp__loom__not_a_registered_tool', 'loom', copilot)).toBe(
      true,
    );
  });
});
