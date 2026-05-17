// Runner tests — full Claude Agent SDK path (post 2026-05-17 codex-flagged fix).
//
// Pre-fix the runner was a two-tier mix of raw @anthropic-ai/sdk (single turn)
// + Claude Agent SDK (tool-call). Codex called this out as drift from "全切
// SDK"; the runner now goes through `@anthropic-ai/claude-agent-sdk.query`
// uniformly. We mock the SDK at module boundary so unit tests don't spawn
// the `claude` binary.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';

const mockSdk = vi.hoisted(() => ({
  messages: [] as unknown[],
  capturedOptions: undefined as unknown,
  capturedPrompt: undefined as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: unknown; options: unknown }) => {
    mockSdk.capturedOptions = options;
    mockSdk.capturedPrompt = prompt;
    const iter = (async function* () {
      for (const m of mockSdk.messages) yield m;
    })();
    return iter;
  }),
  createSdkMcpServer: vi.fn((opts: unknown) => ({
    type: 'sdk',
    name: (opts as { name?: string }).name ?? '',
    instance: {},
  })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

import { runAgentTask, runTask, streamTask } from './runner';

function successResult(text: string, cost_usd = 0.001) {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: cost_usd,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  };
}

describe('runTask (Claude Agent SDK adapter)', () => {
  beforeEach(async () => {
    await resetDb();
    mockSdk.messages = [];
    mockSdk.capturedOptions = undefined;
    mockSdk.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('returns final text + writes cost ledger in USD', async () => {
    mockSdk.messages = [successResult('归因结果：concept', 0.001)];

    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('归因结果：concept');
    expect(result.finishReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.cost_usd).toBe(0.001);

    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    // codex P1 fix: cost_ledger.cost is USD float, NOT micro-USD ints.
    expect(rows[0].cost).toBeCloseTo(0.001, 6);
  });

  it('passes systemPrompt + model + env via options + tools from registry', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as {
      model: string;
      systemPrompt: string;
      env: Record<string, string>;
      tools: string[];
    };
    expect(opts.model).toBe('mimo-v2.5-pro');
    expect(typeof opts.systemPrompt).toBe('string');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(opts.env.CLAUDE_CONFIG_DIR).toMatch(/loom-claude-/);
    // Registry's allowedTools picks up automatically when ctx doesn't override.
    expect(opts.tools).toEqual([]);
    expect(mockSdk.capturedPrompt).toBe('{"test":"payload"}');
  });

  it('honours registry-declared allowedTools (KnowledgeReviewTask → mcp__loom__write_proposal)', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask('KnowledgeReviewTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as { tools: string[] };
    expect(opts.tools).toEqual(['mcp__loom__write_proposal']);
  });

  it('ctx.allowedTools overrides registry default', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'AttributionTask',
      {},
      { db: testDb(), r2: memR2(), allowedTools: ['mcp__custom__foo'] },
    );

    const opts = mockSdk.capturedOptions as { tools: string[] };
    expect(opts.tools).toEqual(['mcp__custom__foo']);
  });

  it('honours middleware.beforeRun + afterRun', async () => {
    mockSdk.messages = [successResult('echoed')];
    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'memory-context',
    }));
    const afterRun = vi.fn(async () => {});

    await runTask(
      'AttributionTask',
      { original: 'data' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun, afterRun } },
    );

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(afterRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockSdk.capturedPrompt)).toContain('memory-context');
  });

  it('throws on SDK error result', async () => {
    mockSdk.messages = [{ type: 'result', subtype: 'error_during_execution' }];

    await expect(runTask('AttributionTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
      /error_during_execution/,
    );
  });

  it('runAgentTask is an alias of runTask', async () => {
    mockSdk.messages = [successResult('agent-text', 0.002)];

    const result = await runAgentTask(
      'AttributionTask',
      { test: 'x' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('agent-text');
    expect(result.cost_usd).toBe(0.002);
  });
});

describe('streamTask middleware + cost', () => {
  beforeEach(async () => {
    await resetDb();
    mockSdk.messages = [];
    mockSdk.capturedOptions = undefined;
    mockSdk.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('runs beforeRun before issuing the query', async () => {
    mockSdk.messages = [successResult('streamed', 0.003)];

    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'pre-stream-memory',
    }));

    const response = streamTask(
      'AttributionTask',
      { hello: 'world' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun } },
    );
    // Drain so the start() callback runs to completion.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockSdk.capturedPrompt)).toContain('pre-stream-memory');
  });

  it('writes USD cost via cost_ledger (not micro-USD)', async () => {
    mockSdk.messages = [successResult('hello', 0.005)];

    const response = streamTask('AttributionTask', { input: 'x' }, { db: testDb(), r2: memR2() });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeCloseTo(0.005, 6);
  });
});
