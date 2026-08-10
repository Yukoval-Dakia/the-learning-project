import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient } from './client';
import { buildMemoryEventIngestHandler } from './triggers';

function sourceEvent(id: string) {
  return {
    id,
    actor_kind: 'user',
    action: 'rate',
    subject_kind: 'event',
    subject_id: 'conjecture-1',
    payload: {
      rating: 'accept',
      conjecture_id: 'conjecture-1',
      corrected_by_owner: true,
      corrected_claim_md: '改写后的判断',
    },
    affected_scopes: [],
    created_at: new Date(1),
    kind: 'event',
  };
}

function ingestJob(eventId: string): Job<{ event_id: string }> {
  return {
    id: `job:${eventId}`,
    name: 'memory_event_ingest',
    data: { event_id: eventId },
    expireInSeconds: 60,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
  };
}

function deterministicSendId(options?: object): string | null {
  return options && 'id' in options && typeof options.id === 'string' ? options.id : null;
}

describe('durable verbatim memory projection claim', () => {
  beforeEach(resetDb);

  it('serializes two concurrent edited-conjecture handlers at the provider boundary', async () => {
    const db = testDb();
    const rows = new Map<string, { id: string; memory: string }>();
    let arrivals = 0;
    let releaseBoundary = () => {};
    const bothLookupsMissed = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const providerAdds = vi.fn();
    const addVerbatimOnce: MemoryClient['addVerbatimOnce'] = vi.fn(
      async (_text, _metadata, _projectionKey, _providerOperation, beforeProviderAdd) => {
        arrivals += 1;
        if (arrivals === 2) releaseBoundary();
        await bothLookupsMissed;
        await beforeProviderAdd();
        providerAdds();
        const memory = { id: 'memory-concurrent', memory: '改写后的判断' };
        rows.set('rate-concurrent', memory);
        return { results: [memory] };
      },
    );
    const findByEventId = vi.fn(async (eventId: string) => {
      const memory = rows.get(eventId);
      return { results: memory ? [memory] : [] };
    });
    const boss = {
      send: vi.fn(async (_name: string, _data: object, options?: object) =>
        deterministicSendId(options),
      ),
    };
    const firstHandler = buildMemoryEventIngestHandler(db, boss, {
      handoffMode: 'write',
      loadEvent: async () => sourceEvent('rate-concurrent'),
      memoryClient: memoryClientMock({ addVerbatimOnce, findByEventId }),
    });
    const secondHandler = buildMemoryEventIngestHandler(db, boss, {
      handoffMode: 'write',
      loadEvent: async () => sourceEvent('rate-concurrent'),
      memoryClient: memoryClientMock({ addVerbatimOnce, findByEventId }),
    });

    const outcomes = await Promise.allSettled([
      firstHandler([ingestJob('rate-concurrent')]),
      secondHandler([ingestJob('rate-concurrent')]),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(addVerbatimOnce).toHaveBeenCalledTimes(2);
    expect(providerAdds).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
  });

  it('retry after external add success and pre-receipt crash converges to the existing row', async () => {
    const db = testDb();
    const rows = new Map<string, { id: string; memory: string }>();
    const addVerbatimOnce: MemoryClient['addVerbatimOnce'] = vi.fn(
      async (_text, _metadata, _projectionKey, _providerOperation, beforeProviderAdd) => {
        await beforeProviderAdd();
        const memory = { id: 'memory-existing', memory: '改写后的判断' };
        rows.set('rate-crash', memory);
        throw new Error('process died after mem0 add');
      },
    );
    const findByEventId = vi.fn(async (eventId: string) => {
      const memory = rows.get(eventId);
      return { results: memory ? [memory] : [] };
    });
    const client = memoryClientMock({ addVerbatimOnce, findByEventId });
    const boss = {
      send: vi.fn(async (_name: string, _data: object, options?: object) =>
        deterministicSendId(options),
      ),
    };
    const handler = buildMemoryEventIngestHandler(db, boss, {
      handoffMode: 'write',
      loadEvent: async () => sourceEvent('rate-crash'),
      memoryClient: client,
    });

    await expect(handler([ingestJob('rate-crash')])).rejects.toThrow('process died after mem0 add');
    await expect(handler([ingestJob('rate-crash')])).resolves.toBeUndefined();

    expect(addVerbatimOnce).toHaveBeenCalledTimes(1);
    expect(findByEventId).toHaveBeenCalledWith('rate-crash');
    expect(rows).toHaveLength(1);
  });
});
