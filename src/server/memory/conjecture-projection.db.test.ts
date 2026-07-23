import type { MemoryClient } from '@/server/memory/client';
import { addVerbatimProjectionOnce } from '@/server/memory/triggers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clientWithStore(
  options: { pauseFirstAdd?: ReturnType<typeof deferred>; crashFirst?: boolean } = {},
) {
  const rows = new Map<string, { id: string; memory: string }>();
  let calls = 0;
  const addVerbatimOnce = vi.fn(async (text: string, _metadata: object, projectionKey: string) => {
    const existing = rows.get(projectionKey);
    if (existing) return { results: [existing] };
    calls += 1;
    if (calls === 1 && options.pauseFirstAdd) await options.pauseFirstAdd.promise;
    const row = { id: `mem_${calls}`, memory: text };
    rows.set(projectionKey, row);
    if (calls === 1 && options.crashFirst) throw new Error('process died after mem0 add');
    return { results: [row] };
  });
  return {
    rows,
    client: { addVerbatimOnce } as Pick<MemoryClient, 'addVerbatimOnce'>,
    addVerbatimOnce,
  };
}

describe('durable verbatim memory projection claim', () => {
  beforeEach(resetDb);

  it('serializes two independent concurrent workers to one CORE projection', async () => {
    const pause = deferred();
    const store = clientWithStore({ pauseFirstAdd: pause });
    const db = testDb();
    const input = {
      text: '改写后的判断',
      metadata: { event_id: 'rate_1' },
      projectionKey: 'conjecture-edit:rate_1',
    };

    const first = addVerbatimProjectionOnce(db, store.client, input);
    await vi.waitFor(() => expect(store.addVerbatimOnce).toHaveBeenCalledTimes(1));
    const second = addVerbatimProjectionOnce(db, store.client, input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.addVerbatimOnce).toHaveBeenCalledTimes(1);

    pause.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.results).toEqual(b.results);
    expect(store.addVerbatimOnce).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(1);
  });

  it('retry after external add success and pre-receipt crash converges to the existing row', async () => {
    const store = clientWithStore({ crashFirst: true });
    const input = {
      text: '改写后的判断',
      metadata: { event_id: 'rate_2' },
      projectionKey: 'conjecture-edit:rate_2',
    };

    await expect(addVerbatimProjectionOnce(testDb(), store.client, input)).rejects.toThrow(
      'process died after mem0 add',
    );
    await expect(addVerbatimProjectionOnce(testDb(), store.client, input)).resolves.toMatchObject({
      results: [{ id: 'mem_1' }],
    });

    expect(store.rows).toHaveLength(1);
  });
});
