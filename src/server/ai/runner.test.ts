import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { runTask, streamTask } from './runner';

// AI SDK v6 provider-level (LanguageModelV3) shapes.
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
  beforeEach(async () => {
    await resetDb();
  });

  it('calls model and returns text + writes CostLedger', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => makeMockGenerateResult('归因结果：concept'),
    });

    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { db: testDb(), r2: memR2(), model: mockModel },
    );

    expect(result.text).toBe('归因结果：concept');
    // Verify cost_ledger row was written.
    const { cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
  });

  it('returns finishReason in result', async () => {
    const mockModel = new MockLanguageModelV3({
      doGenerate: async () => makeMockGenerateResult('ok'),
    });
    const r = await runTask('AttributionTask', {}, { db: testDb(), r2: memR2(), model: mockModel });
    expect(r.finishReason).toBe('stop');
  });

  it('throws for unknown task kind', async () => {
    await expect(runTask('NonexistentTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
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

    await runTask(
      'VisionExtractTask',
      {
        text: 'Extract blocks from page_index=0. Return strict JSON.',
        images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
      },
      { db: testDb(), r2: memR2(), model: mockModel },
    );

    const serialized = JSON.stringify(seenPrompt);
    expect(serialized).toContain('"type":"file"');
    expect(serialized).toContain('image/png');
  });
});

// V3 stream chunk usage / finishReason shape.
function makeV3Usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

describe('runTask streaming with tools', () => {
  beforeEach(async () => {
    await resetDb();
  });

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

    const stream = streamTask(
      'AttributionTask',
      { test: true },
      {
        db: testDb(),
        r2: memR2(),
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

    const { tool_call_log, cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');

    // Verify ToolCallLog was written.
    const toolRows = await testDb()
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, 'echo_tool'));
    expect(toolRows.length).toBeGreaterThanOrEqual(1);
    expect(toolRows[0].task_kind).toBe('AttributionTask');

    // Verify CostLedger row was also written by onFinish.
    const costRows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(costRows).toHaveLength(1);
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

    const stream = streamTask(
      'AttributionTask',
      {},
      { db: testDb(), r2: memR2(), model: mockModel },
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
