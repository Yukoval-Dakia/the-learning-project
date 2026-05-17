// Runner tests — two-tier adapter (raw Anthropic SDK + Claude Agent SDK).
//
// Single-turn `runTask` is mocked at the @anthropic-ai/sdk module boundary
// so we don't make real HTTP. Tool-call `runAgentTask` is mocked at the
// claude-agent-sdk module so we don't spawn the `claude` binary subprocess.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';

// ---------- @anthropic-ai/sdk mock ----------
const mockAnthropic = vi.hoisted(() => ({
  capturedRequest: undefined as
    | undefined
    | {
        model: string;
        system: string;
        messages: unknown[];
      },
  response: {
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class AnthropicMock {
    constructor(_opts: unknown) {
      void _opts;
    }
    messages = {
      create: vi.fn(async (req: { model: string; system: string; messages: unknown[] }) => {
        mockAnthropic.capturedRequest = req;
        return mockAnthropic.response;
      }),
    };
  }
  return { default: AnthropicMock };
});

// ---------- @anthropic-ai/claude-agent-sdk mock ----------
const mockAgentSdk = vi.hoisted(() => ({
  messages: [] as unknown[],
  capturedOptions: undefined as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { prompt: unknown; options: unknown }) => {
    mockAgentSdk.capturedOptions = options;
    const iter = (async function* () {
      for (const m of mockAgentSdk.messages) yield m;
    })();
    return iter;
  }),
}));

import { runAgentTask, runTask } from './runner';

describe('runTask (raw @anthropic-ai/sdk)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAnthropic.capturedRequest = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('returns text + writes cost ledger', async () => {
    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('OK');
    expect(result.finishReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);

    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
  });

  it('passes systemPrompt + model + JSON-stringified input', async () => {
    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    expect(mockAnthropic.capturedRequest?.model).toBe('mimo-v2.5-pro');
    expect(typeof mockAnthropic.capturedRequest?.system).toBe('string');
    const messages = mockAnthropic.capturedRequest?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('{"test":"payload"}');
  });

  it('honours middleware.beforeRun + afterRun', async () => {
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
    const messages = mockAnthropic.capturedRequest?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].content).toContain('memory-context');
  });

  it('throws for unknown task kind', async () => {
    await expect(runTask('NonexistentTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
      /unknown task/i,
    );
  });
});

describe('runAgentTask (claude-agent-sdk subprocess)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAgentSdk.messages = [];
    mockAgentSdk.capturedOptions = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('returns final text from result message + writes cost ledger', async () => {
    mockAgentSdk.messages = [
      {
        type: 'result',
        subtype: 'success',
        result: 'agent-text',
        stop_reason: 'end_turn',
        total_cost_usd: 0.001,
        usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 0 },
      },
    ];

    const result = await runAgentTask(
      'AttributionTask',
      { test: 'x' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('agent-text');
    expect(result.cost_usd).toBe(0.001);
    expect(result.usage.inputTokens).toBe(200);

    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(1000); // 0.001 USD → 1000 micro-USD
  });

  it('sets ANTHROPIC_BASE_URL + API key in agent env', async () => {
    mockAgentSdk.messages = [
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ];

    await runAgentTask('AttributionTask', {}, { db: testDb(), r2: memR2() });

    const opts = mockAgentSdk.capturedOptions as {
      env: Record<string, string>;
      model: string;
      systemPrompt: string;
    };
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(opts.env.CLAUDE_CONFIG_DIR).toMatch(/loom-claude-/);
    expect(opts.model).toBe('mimo-v2.5-pro');
  });

  it('throws when SDK emits result_error', async () => {
    mockAgentSdk.messages = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ];

    await expect(
      runAgentTask('AttributionTask', {}, { db: testDb(), r2: memR2() }),
    ).rejects.toThrow(/error_during_execution/);
  });
});
