import type { Db } from '@/db/client';
import type { RunTaskResult } from '@/server/ai/runner';
import { describe, expect, it, vi } from 'vitest';
import { makeRunTaskFn, makeRunTaskTextFn } from './runner-fn';

const { runTask } = vi.hoisted(() => ({ runTask: vi.fn() }));

vi.mock('@/server/ai/runner', () => ({ runTask }));

describe('bound runTask adapters', () => {
  const db = { name: 'bound-db' } as unknown as Db;
  const fullResult: RunTaskResult = {
    task_run_id: 'run-1',
    text: 'answer',
    finishReason: 'end_turn',
    usage: { inputTokens: 2, outputTokens: 3 },
    cost_usd: 0.01,
    structured_output: { answer: 42 },
  };

  it('lazy-loads runTask and returns the full result by identity', async () => {
    runTask.mockResolvedValueOnce(fullResult);

    const result = await makeRunTaskFn(db)('VariantGenTask', { prompt: 'x' });

    expect(result).toBe(fullResult);
    expect(runTask).toHaveBeenCalledOnce();
  });

  it('merges base then call context while binding db last and stripping retry', async () => {
    runTask.mockResolvedValueOnce(fullResult);
    const bound = makeRunTaskFn(db, {
      allowedTools: ['base'],
      subjectProfile: { id: 'base' },
      db: { name: 'base-db' },
      enableTransientRetry: true,
    } as never);

    await bound('VariantGenTask', {}, {
      allowedTools: ['call'],
      db: { name: 'call-db' },
      enableTransientRetry: true,
    } as never);

    expect(runTask).toHaveBeenCalledWith(
      'VariantGenTask',
      {},
      {
        allowedTools: ['call'],
        subjectProfile: { id: 'base' },
        db,
      },
    );
  });

  it('projects text-only results to exactly { text }', async () => {
    runTask.mockResolvedValueOnce(fullResult);

    const result = await makeRunTaskTextFn(db)('TaggingTask', {});

    expect(result).toEqual({ text: 'answer' });
    expect(Object.keys(result)).toEqual(['text']);
  });

  it('does not expose db or transient retry in public call context', () => {
    const bound = makeRunTaskFn(db);

    const assertRejectedContextTypes = () => {
      // @ts-expect-error db is bound by the adapter
      void bound('VariantGenTask', {}, { db });
      // @ts-expect-error transient retry is reserved for sanctioned direct vision seams
      void bound('VariantGenTask', {}, { enableTransientRetry: true });
    };

    expect(assertRejectedContextTypes).toBeTypeOf('function');
  });
});
