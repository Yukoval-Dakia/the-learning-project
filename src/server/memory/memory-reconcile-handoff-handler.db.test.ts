import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient, MemoryEventInput } from './client';
import { MEMORY_RECONCILE_QUEUE, buildMemoryEventIngestHandler } from './triggers';

function ingestJob(eventId: string): Job<{ event_id: string }> {
  return {
    id: `job:${eventId}`,
    name: 'memory_event_ingest',
    data: { event_id: eventId },
    expireInSeconds: 60,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  };
}

function sourceEvent(id: string): MemoryEventInput {
  return {
    id,
    actor_kind: 'user',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'question-1',
    payload: {},
    affected_scopes: [],
    created_at: new Date(1),
    kind: 'event',
  };
}

function deterministicSendId(options: object): string | null {
  return 'id' in options && typeof options.id === 'string' ? options.id : null;
}

describe('memory reconcile ingest handoff modes and crashes', () => {
  beforeEach(resetDb);

  it('allows only one generic handler through the provider boundary after concurrent lookup misses', async () => {
    const db = testDb();
    const sourceId = 'generic-concurrent';
    const externalMemories = new Map<string, { id: string; memory: string }>();
    const findByEventId = vi.fn(async (eventId: string) => {
      const memory = externalMemories.get(eventId);
      return { results: memory ? [memory] : [] };
    });
    let boundaryArrivals = 0;
    let releaseBoundary = () => {};
    const bothAtBoundary = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const providerAdd = vi.fn();
    const addEventMemoryOnce: MemoryClient['addEventMemoryOnce'] = vi.fn(
      async (input, _providerOperation, beforeProviderAdd) => {
        const existing = await findByEventId(input.id);
        if (existing.results.length > 0)
          return { result: existing, resolution: 'event_lookup' as const };
        boundaryArrivals += 1;
        if (boundaryArrivals === 2) releaseBoundary();
        await bothAtBoundary;
        await beforeProviderAdd();
        providerAdd();
        const memory = { id: 'memory-concurrent', memory: 'one paid lifecycle' };
        externalMemories.set(input.id, memory);
        return { result: { results: [memory] }, resolution: 'provider_result' as const };
      },
    );
    const send = vi.fn(async (_queue: string, _data: object, options?: object) =>
      options ? deterministicSendId(options) : null,
    );
    const dependencies = {
      handoffMode: 'write' as const,
      loadEvent: async () => sourceEvent(sourceId),
      memoryClient: memoryClientMock({ addEventMemoryOnce, findByEventId }),
    };
    const firstHandler = buildMemoryEventIngestHandler(db, { send }, dependencies);
    const secondHandler = buildMemoryEventIngestHandler(db, { send }, dependencies);

    const settled = await Promise.allSettled([
      firstHandler([ingestJob(sourceId)]),
      secondHandler([ingestJob(sourceId)]),
    ]);

    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(findByEventId).toHaveBeenCalledTimes(2);
    expect(addEventMemoryOnce).toHaveBeenCalledTimes(2);
    expect(providerAdd).toHaveBeenCalledOnce();
    expect(externalMemories.size).toBe(1);
    expect(send.mock.calls.filter(([queue]) => queue === MEMORY_RECONCILE_QUEUE)).toHaveLength(1);
    const rows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, sourceId));
    const completions = rows.filter((row) => {
      const payload = row.payload;
      return (
        payload &&
        typeof payload === 'object' &&
        'handoff_kind' in payload &&
        payload.handoff_kind === 'ingest_completed'
      );
    });
    expect(completions).toHaveLength(1);
  });
});
