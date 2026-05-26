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

// Mock writeToolCallLog — bridge calls it but we just need to capture invocations.
const captured = vi.hoisted(() => ({
  toolCallLogs: [] as unknown[],
}));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: vi.fn(async (_db: unknown, entry: unknown) => {
    captured.toolCallLogs.push(entry);
    return 'mock_tcl_id';
  }),
}));

import { buildMcpServerFromRegistry } from './mcp-bridge';

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
