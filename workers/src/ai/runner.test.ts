import type { D1Database } from '@cloudflare/workers-types';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runTask, streamTask } from './runner';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return { run: async () => ({ success: true }) };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

// AI SDK v6 provider-level (LanguageModelV3) shapes:
// - finishReason: { unified, raw }
// - usage.inputTokens / outputTokens are nested objects with `total`
// generateText() unwraps these into plain string + plain numbers in the public API.
function makeMockGenerateResult(text: string, unifiedReason: 'stop' | 'length' = 'stop') {
  return {
    finishReason: { unified: unifiedReason, raw: unifiedReason },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: 50, reasoning: undefined },
    },
    content: [{ type: 'text' as const, text }],
    warnings: [],
  };
}

describe('runTask (single-shot, no tools)', () => {
  it('calls model and returns text + writes CostLedger', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => makeMockGenerateResult('归因结果：concept'),
    });

    const { db, calls } = makeMockDb();
    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { env: { DB: db } as never, model: mockModel },
    );

    expect(result.text).toBe('归因结果：concept');
    expect(calls.some((c) => /cost_ledger/i.test(c.sql))).toBe(true);
  });

  it('returns finishReason in result', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => makeMockGenerateResult('ok'),
    });
    const { db } = makeMockDb();
    const r = await runTask('AttributionTask', {}, { env: { DB: db } as never, model: mockModel });
    expect(r.finishReason).toBe('stop');
  });

  it('throws for unknown task kind', async () => {
    const { db } = makeMockDb();
    await expect(runTask('NonexistentTask', {}, { env: { DB: db } as never })).rejects.toThrow(
      /unknown task/i,
    );
  });

  it('passes image content parts when input is multimodal (AI SDK v6 normalizes image→file)', async () => {
    let seenPrompt: unknown;
    const mockModel = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seenPrompt = options.prompt;
        return makeMockGenerateResult('{"blocks":[]}');
      },
    });
    const { db } = makeMockDb();

    await runTask(
      'VisionExtractTask',
      {
        text: 'Extract blocks from page_index=0. Return strict JSON.',
        images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
      },
      { env: { DB: db } as never, model: mockModel },
    );

    const serialized = JSON.stringify(seenPrompt);
    expect(serialized).toContain('"type":"file"');
    expect(serialized).toContain('image/png');
  });
});

// V3 stream chunk usage / finishReason shape (same nested layout as doGenerate).
function makeV3Usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

describe('runTask streaming with tools', () => {
  it('streams text and writes ToolCallLog per tool call', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'echo_tool',
              // V3: input is stringified JSON.
              input: JSON.stringify({ msg: 'hi' }),
            });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_use' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db, calls } = makeMockDb();
    const stream = streamTask(
      'AttributionTask',
      { test: true },
      {
        env: { DB: db } as never,
        model: mockModel,
        tools: {
          echo_tool: {
            description: 'echo input back',
            inputSchema: z.object({ msg: z.string() }),
            execute: async ({ msg }: { msg: string }) => ({ echoed: msg }),
          },
        },
      },
    );

    // Drain the stream so onStepFinish + onFinish fire.
    const reader = stream.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Verify ToolCallLog was written. binds index 3 = tool_name (id, task_run_id, task_kind, tool_name, ...)
    const toolCallLogged = calls.find((c) => /tool_call_log/i.test(c.sql));
    expect(toolCallLogged).toBeDefined();
    expect(toolCallLogged?.binds[3]).toBe('echo_tool');

    // Verify CostLedger row was also written by onFinish.
    const costLogged = calls.find((c) => /cost_ledger/i.test(c.sql));
    expect(costLogged).toBeDefined();
    expect(costLogged?.binds[1]).toBe('AttributionTask');
  });

  it('returns a Response with a streaming body', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't0' });
            controller.enqueue({ type: 'text-delta', id: 't0', delta: 'hello' });
            controller.enqueue({ type: 'text-end', id: 't0' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db } = makeMockDb();
    const stream = streamTask(
      'AttributionTask',
      {},
      { env: { DB: db } as never, model: mockModel },
    );

    expect(stream).toBeInstanceOf(Response);
    expect(stream.body).toBeTruthy();

    // Drain stream.
    const reader = stream.body?.getReader();
    let total = '';
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += new TextDecoder().decode(value);
      }
    }
    expect(total).toContain('hello');
  });
});
