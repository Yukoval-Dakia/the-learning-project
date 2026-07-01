import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureMemoryUsageFetchInstalled,
  resetMemoryUsageFetchForTests,
  runWithMemoryCostTracking,
} from './usage-fetch';

const db = {} as never;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('memory usage fetch shim', () => {
  const writeCostLedgerFn = vi.fn(async () => {});

  beforeEach(() => {
    writeCostLedgerFn.mockClear();
    resetMemoryUsageFetchForTests();
  });

  afterEach(() => {
    resetMemoryUsageFetchForTests();
  });

  it('records memory_embed on /embeddings when cost context is active', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/embeddings')) {
        return jsonResponse({
          model: 'text-embedding-v4',
          usage: { prompt_tokens: 2_000_000, total_tokens: 2_000_000 },
          data: [{ embedding: [0.1], index: 0 }],
        });
      }
      return jsonResponse({});
    });
    globalThis.fetch = mockFetch as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await runWithMemoryCostTracking({ db, writeCostLedgerFn }, async () => {
      await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
        method: 'POST',
      });
    });

    await vi.waitFor(() => expect(writeCostLedgerFn).toHaveBeenCalledTimes(1));
    expect(writeCostLedgerFn).toHaveBeenCalledWith(db, {
      task_kind: 'memory_embed',
      provider: 'bailian',
      model: 'text-embedding-v4',
      cost: 1,
      currency: 'CNY',
      tokens_in: 2_000_000,
      tokens_out: 0,
      task_run_id: undefined,
    });
  });

  it('records memory_extract on /chat/completions when cost context is active', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/chat/completions')) {
        return jsonResponse({
          model: 'glm-5.2',
          usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 },
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        });
      }
      return jsonResponse({});
    });
    globalThis.fetch = mockFetch as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await runWithMemoryCostTracking(
      { db, taskRunId: 'tr_mem', writeCostLedgerFn, llmModel: 'glm-5.2' },
      async () => {
        await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
          method: 'POST',
        });
      },
    );

    await vi.waitFor(() => expect(writeCostLedgerFn).toHaveBeenCalledTimes(1));
    expect(writeCostLedgerFn).toHaveBeenCalledWith(db, {
      task_run_id: 'tr_mem',
      task_kind: 'memory_extract',
      provider: 'glm',
      model: 'glm-5.2',
      cost: 2.5,
      currency: 'CNY',
      tokens_in: 1_000_000,
      tokens_out: 500_000,
    });
  });

  it('does not write ledger without cost context', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        model: 'text-embedding-v4',
        usage: { prompt_tokens: 100, total_tokens: 100 },
      }),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
    await new Promise((r) => setTimeout(r, 10));
    expect(writeCostLedgerFn).not.toHaveBeenCalled();
  });

  it('swallows ledger write failures without throwing', async () => {
    const failingWrite = vi.fn(async () => {
      throw new Error('db down');
    });
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        model: 'text-embedding-v4',
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    ensureMemoryUsageFetchInstalled();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runWithMemoryCostTracking({ db, writeCostLedgerFn: failingWrite }, async () => {
        await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(failingWrite).toHaveBeenCalledTimes(1));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
