import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { runTask } from './runner';

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
    const r = await runTask(
      'AttributionTask',
      {},
      { env: { DB: db } as never, model: mockModel },
    );
    expect(r.finishReason).toBe('stop');
  });

  it('throws for unknown task kind', async () => {
    const { db } = makeMockDb();
    await expect(
      runTask('NonexistentTask', {}, { env: { DB: db } as never }),
    ).rejects.toThrow(/unknown task/i);
  });
});
