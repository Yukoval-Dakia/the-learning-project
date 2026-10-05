// YUK-921 P2 (YUK-1021) — pi-side tool mount tests.
//
// Domain mount: buildPiDomainAgentTools compiles registry DomainTools into pi
// AgentTools with `mcp__<server>__<tool>` wire names and delegates execute to
// the SAME executeDomainToolCall pipeline — so tool_call_log rows, tool_use
// mirrors and gate semantics are asserted identical to the mcp-bridge suite.
//
// Remote mount: connectPiRemoteMcp is exercised with a mocked MCP SDK client
// (dynamic imports resolve through vi.mock the same as static ones). The mock
// reads shared state at call time so tests can prime results before/while
// connecting without racing the constructor.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { __resetRegistryForTests, registerTool } from './registry';

const captured = vi.hoisted(() => ({
  toolCallLogs: [] as Array<Record<string, unknown>>,
  mirroredLinks: [] as Array<{ tcl_id: string; event_id: string }>,
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: vi.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    captured.toolCallLogs.push(entry);
    return 'mock_tcl_id';
  }),
  setToolCallLogMirroredEventId: vi.fn(async (_db: unknown, tcl_id: string, event_id: string) => {
    captured.mirroredLinks.push({ tcl_id, event_id });
  }),
}));
vi.mock('@/kernel/events', () => ({
  writeEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    captured.events.push(input);
    return (input as { id: string }).id;
  }),
}));

const mcp = vi.hoisted(() => ({
  listToolsResult: { tools: [] as Array<Record<string, unknown>> },
  calls: [] as Array<{ name: string; arguments: unknown }>,
  callResult: { content: [{ type: 'text', text: 'remote ok' }] } as unknown,
  closedCount: 0,
  connectError: undefined as Error | undefined,
  lastTransport: undefined as unknown,
  lastConnectOpts: undefined as unknown,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(transport: unknown, opts: unknown) {
      mcp.lastTransport = transport;
      mcp.lastConnectOpts = opts;
      if (mcp.connectError) throw mcp.connectError;
    }
    async listTools() {
      return mcp.listToolsResult;
    }
    async callTool(args: { name: string; arguments: unknown }) {
      mcp.calls.push(args);
      return mcp.callResult;
    }
    async close() {
      mcp.closedCount += 1;
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      public url: URL,
      public init: { requestInit?: { headers?: Record<string, string> } },
    ) {}
  },
}));

import {
  buildPiDomainAgentTools,
  connectPiRemoteMcp,
  piDomainMount,
  piRemoteMcpMount,
  piToolWireName,
} from './pi-tools';

function makeTool(name: string, runFn: (input: { q: string }) => unknown): DomainTool {
  return {
    name,
    description: `Desc for ${name}`,
    effect: 'read',
    inputSchema: z.object({ q: z.string().min(1) }),
    outputSchema: z.object({ hits: z.array(z.string()) }),
    costClass: 'local',
    async execute(_ctx, input) {
      return runFn(input as { q: string }) as never;
    },
    summarize: (input, output) =>
      `summary:${(input as { q: string }).q}:${(output as { hits: string[] }).hits.length}`,
    mirrorEvent: 'always',
  } as DomainTool;
}

const ctx: ToolContext = {
  db: {} as never,
  taskRunId: 'tr_pi_test',
  callerActor: { kind: 'agent', ref: 'agent:test:pi' },
  causedByEventId: 'evt_cause_1',
};

beforeEach(() => {
  __resetRegistryForTests();
  captured.toolCallLogs.length = 0;
  captured.mirroredLinks.length = 0;
  captured.events.length = 0;
  mcp.listToolsResult = { tools: [] };
  mcp.calls.length = 0;
  mcp.callResult = { content: [{ type: 'text', text: 'remote ok' }] };
  mcp.closedCount = 0;
  mcp.connectError = undefined;
  mcp.lastTransport = undefined;
  mcp.lastConnectOpts = undefined;
});

describe('piToolWireName / mount descriptors', () => {
  it('namespaces tools exactly like the SDK mcp__<server>__<tool> convention', () => {
    expect(piToolWireName('loom', 'read_mistakes')).toBe('mcp__loom__read_mistakes');
    expect(piToolWireName('exa', 'web_search_exa')).toBe('mcp__exa__web_search_exa');
  });

  it('piDomainMount/piRemoteMcpMount build the discriminated descriptors', () => {
    const domain = piDomainMount({
      ctx,
      serverName: 'loom',
      toolNames: ['read_mistakes'],
    });
    expect(domain).toMatchObject({ type: 'domain', options: { serverName: 'loom' } });
    const remote = piRemoteMcpMount(
      'exa',
      { type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': 'k' } },
      ['web_search_exa'],
    );
    expect(remote).toMatchObject({ type: 'remote-mcp', serverName: 'exa' });
  });
});

describe('buildPiDomainAgentTools', () => {
  it('compiles a DomainTool into an AgentTool with wire name + JSON-schema parameters', () => {
    registerTool(makeTool('read_mistakes', () => ({ hits: ['a'] })));
    const [agentTool] = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom',
      toolNames: ['read_mistakes'],
    });
    expect(agentTool.name).toBe('mcp__loom__read_mistakes');
    expect(agentTool.description).toBe('Desc for read_mistakes');
    expect(agentTool.parameters).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string', minLength: 1 } },
      required: ['q'],
    });
  });

  it('throws when the tool is not registered', () => {
    expect(() =>
      buildPiDomainAgentTools({ ctx, serverName: 'loom', toolNames: ['ghost_tool'] }),
    ).toThrow(/tool 'ghost_tool' is not registered/);
  });

  it('execute runs the shared pipeline: result content + tool_call_log + tool_use mirror', async () => {
    registerTool(makeTool('read_mistakes', () => ({ hits: ['h1', 'h2'] })));
    const [agentTool] = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom',
      toolNames: ['read_mistakes'],
      taskKind: 'DreamingTask',
    });
    const result = await agentTool.execute('toolCall_pi_1', { q: 'fractions' }, undefined);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.summary).toBe('summary:fractions:2');
    expect(parsed.output).toEqual({ hits: ['h1', 'h2'] });
    // The pi loop's native toolCall.id surfaces as the correlated tool_use_id —
    // the SDK path learned it via the PreToolUse claim hook instead.
    expect(parsed.tool_use_id).toBe('toolCall_pi_1');

    expect(captured.toolCallLogs).toHaveLength(1);
    expect(captured.toolCallLogs[0]).toMatchObject({
      task_run_id: 'tr_pi_test',
      task_kind: 'DreamingTask',
      tool_name: 'read_mistakes',
      effect: 'read',
      input_json: { q: 'fractions' },
      output_json: { hits: ['h1', 'h2'] },
    });
    // mirrorEvent 'always' + agent caller → mirror fires.
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: 'tool_use',
      outcome: 'success',
      task_run_id: 'tr_pi_test',
      payload: { tool_name: 'read_mistakes', args: { q: 'fractions' } },
    });
    expect(captured.mirroredLinks).toEqual([
      { tcl_id: 'mock_tcl_id', event_id: captured.events[0]?.id },
    ]);
  });

  it('execute encodes a zod input violation as an error payload (no throw)', async () => {
    registerTool(makeTool('read_mistakes', () => ({ hits: [] })));
    const [agentTool] = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom',
      toolNames: ['read_mistakes'],
    });
    const result = await agentTool.execute('tc_2', { q: '' }, undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toMatch(/q/);
    expect(captured.toolCallLogs[0]).toMatchObject({ error_reason: expect.stringContaining('q') });
  });

  it('forwards beforeExecute gate reasons into the error payload', async () => {
    registerTool(makeTool('read_mistakes', () => ({ hits: [] })));
    const [agentTool] = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom',
      toolNames: ['read_mistakes'],
      beforeExecute: () => 'budget exhausted',
    });
    const result = await agentTool.execute('tc_3', { q: 'x' }, undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toBe('budget exhausted');
    expect(captured.toolCallLogs[0]).toMatchObject({ error_reason: 'budget exhausted' });
  });
});

describe('connectPiRemoteMcp', () => {
  const mount = () =>
    piRemoteMcpMount(
      'exa',
      { type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': 'k-1' } },
      ['web_search_exa', 'web_fetch_exa'],
    ) as Extract<ReturnType<typeof piRemoteMcpMount>, { type: 'remote-mcp' }>;

  it('connects with auth headers and exposes only the scoped tools under wire names', async () => {
    mcp.listToolsResult = {
      tools: [
        {
          name: 'web_search_exa',
          description: 'web search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
        { name: 'unrelated_tool', description: 'not scoped' },
      ],
    };
    const handle = await connectPiRemoteMcp(mount(), 5_000);
    expect(mcp.lastConnectOpts).toMatchObject({ timeout: 5_000 });
    const transport = mcp.lastTransport as {
      url: URL;
      init: { requestInit: { headers: Record<string, string> } };
    };
    expect(transport.url.toString()).toBe('https://mcp.exa.ai/mcp');
    expect(transport.init.requestInit.headers).toEqual({ 'x-api-key': 'k-1' });
    // Scope filter: web_fetch_exa absent from the listing → not mounted;
    // unrelated_tool never scoped.
    expect(handle.tools.map((t) => t.name)).toEqual(['mcp__exa__web_search_exa']);
    expect(handle.tools[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
    await handle.close();
    expect(mcp.closedCount).toBe(1);
  });

  it('bridges callTool results into AgentToolResult text content', async () => {
    mcp.listToolsResult = {
      tools: [{ name: 'web_search_exa', inputSchema: { type: 'object' } }],
    };
    mcp.callResult = { content: [{ type: 'text', text: 'search payload' }] };
    const handle = await connectPiRemoteMcp(mount(), 5_000);
    const result = await handle.tools[0]?.execute('tc_r1', { query: 'attention' }, undefined);
    expect(mcp.calls).toEqual([{ name: 'web_search_exa', arguments: { query: 'attention' } }]);
    expect(result?.content?.[0]).toMatchObject({ type: 'text', text: 'search payload' });
    await handle.close();
  });

  it('turns an isError remote result into a thrown execute (pi error convention)', async () => {
    mcp.listToolsResult = { tools: [{ name: 'web_fetch_exa', inputSchema: { type: 'object' } }] };
    mcp.callResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    const handle = await connectPiRemoteMcp(mount(), 5_000);
    await expect(handle.tools[0]?.execute('tc_r2', {}, undefined)).rejects.toThrow(/boom/);
    await handle.close();
  });

  it('fails startup loudly and closes the client when the remote connect fails', async () => {
    mcp.connectError = new Error('remote unreachable');
    await expect(connectPiRemoteMcp(mount(), 5_000)).rejects.toThrow(/remote unreachable/);
    expect(mcp.closedCount).toBe(1);
  });
});
