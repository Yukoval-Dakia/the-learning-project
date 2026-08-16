import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureMemoryUsageFetchInstalled,
  resetMemoryUsageFetchForTests,
  runWithMemoryCostTracking,
} from './usage-fetch';

const db = {} as never;
const originalFetch = globalThis.fetch;

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
    globalThis.fetch = originalFetch;
  });

  it('records exact 百炼 embedding usage with its stable task run id', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        model: 'text-embedding-v4',
        usage: { prompt_tokens: 2_000_000, total_tokens: 2_000_000 },
        data: [{ embedding: [0.1], index: 0 }],
      }),
    ) as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await runWithMemoryCostTracking(
      { db, taskRunId: 'memory-brief-regen:job-1', writeCostLedgerFn },
      async () => {
        await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
      },
    );

    await vi.waitFor(() => expect(writeCostLedgerFn).toHaveBeenCalledTimes(1));
    expect(writeCostLedgerFn).toHaveBeenCalledWith(db, {
      task_run_id: 'memory-brief-regen:job-1',
      task_kind: 'memory_embed',
      provider: 'bailian',
      model: 'text-embedding-v4',
      cost: 1,
      currency: 'CNY',
      tokens_in: 2_000_000,
      tokens_out: 0,
    });
  });

  it('records exact GLM extraction usage', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        model: 'glm-5.2',
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          total_tokens: 1_500_000,
        },
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    ) as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await runWithMemoryCostTracking(
      { db, taskRunId: 'memory-event-ingest:job-2', writeCostLedgerFn },
      async () => {
        await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
      },
    );

    await vi.waitFor(() => expect(writeCostLedgerFn).toHaveBeenCalledTimes(1));
    expect(writeCostLedgerFn).toHaveBeenCalledWith(db, {
      task_run_id: 'memory-event-ingest:job-2',
      task_kind: 'memory_extract',
      provider: 'glm',
      model: 'glm-5.2',
      cost: 2.5,
      currency: 'CNY',
      tokens_in: 1_000_000,
      tokens_out: 500_000,
    });
  });

  it('does not write without usage evidence or an active memory scope', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ model: 'text-embedding-v4' }),
    ) as typeof fetch;
    ensureMemoryUsageFetchInstalled();

    await runWithMemoryCostTracking({ db, writeCostLedgerFn }, async () => {
      await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
    });
    await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeCostLedgerFn).not.toHaveBeenCalled();
  });

  it('does not let ledger failures fail the Mem0 request', async () => {
    const failingWrite = vi.fn(async () => {
      throw new Error('db down');
    });
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        model: 'text-embedding-v4',
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }),
    ) as typeof fetch;
    ensureMemoryUsageFetchInstalled();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runWithMemoryCostTracking({ db, writeCostLedgerFn: failingWrite }, () =>
        fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'),
      ),
    ).resolves.toBeInstanceOf(Response);

    await vi.waitFor(() => expect(failingWrite).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });
});
