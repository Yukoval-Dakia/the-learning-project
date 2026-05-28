import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { __resetBootstrapForTests } from './bootstrap';
import { __resetRegistryForTests, registerTool } from './registry';
import type { DomainTool, ToolContext } from './types';

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
vi.mock('@/server/events/queries', () => ({
  writeEvent: vi.fn(async (_db: unknown, input: unknown) => {
    captured.events.push(input);
    return (input as { id: string }).id;
  }),
}));

import { __resolveMirrorPolicy, buildMcpServerFromRegistry } from './mcp-bridge';

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
    __resetBootstrapForTests();
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

  it('handler invokes tool + writes tool_call_log + returns MCP content shape', async () => {
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_x',
        { q: z.string() },
        (i) => ({ len: i.q.length }),
        (i, o) => `demo_x · ${i.q.length} → ${o.len}`,
      ),
    );

    buildMcpServerFromRegistry({ ctx, serverName: 'loom_v2', toolNames: ['demo_x'] });
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

  it('writes experimental:tool_use mirror when caller is agent + policy fires', async () => {
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
    expect(ev.action).toBe('experimental:tool_use');
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
