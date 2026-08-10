import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient, MemoryEventInput } from './client';
import { buildMemoryEventIngestHandler } from './triggers';

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

  it.each([
    { mode: 'observe', persistsIntents: false },
    { mode: 'write', persistsIntents: true },
    { mode: 'recover', persistsIntents: true },
    { mode: 'drain', persistsIntents: false },
  ] as const)('applies $mode persistence semantics in the real ingest handler', async (fixture) => {
    const db = testDb();
    const sourceId = `mode-${fixture.mode}`;
    const addEventMemoryOnce: MemoryClient['addEventMemoryOnce'] = vi.fn(
      async (_event, _providerOperation, beforeProviderAdd) => {
        await beforeProviderAdd();
        return {
          result: { results: [{ id: `memory-${fixture.mode}`, memory: fixture.mode }] },
          resolution: 'provider_result' as const,
        };
      },
    );
    const send = vi.fn(async (_queue: string, _data: object, options?: object) =>
      options ? deterministicSendId(options) : null,
    );
    const handler = buildMemoryEventIngestHandler(
      db,
      { send },
      {
        handoffMode: fixture.mode,
        loadEvent: async () => sourceEvent(sourceId),
        memoryClient: memoryClientMock({ addEventMemoryOnce }),
      },
    );

    await handler([ingestJob(sourceId)]);

    const rows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, sourceId));
    const kinds = rows.flatMap((row) => {
      const payload = row.payload;
      return payload && typeof payload === 'object' && 'handoff_kind' in payload
        ? [payload.handoff_kind]
        : [];
    });
    expect(kinds).toContain('add_started');
    expect(kinds).toContain('ingest_completed');
    expect(kinds.includes('reconcile_intent')).toBe(fixture.persistsIntents);
    expect(kinds.includes('reconcile_dispatch_complete')).toBe(fixture.persistsIntents);
  });

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
    expect(send).toHaveBeenCalledOnce();
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

  it('recovers a generic inferred add after external success without a second provider add', async () => {
    const db = testDb();
    const sourceId = 'generic-crash';
    const rows = new Map<string, { id: string; memory: string }>();
    const findByEventId = vi.fn(async (eventId: string) => {
      const memory = rows.get(eventId);
      return { results: memory ? [memory] : [] };
    });
    const providerAdd = vi.fn();
    const addEventMemoryOnce: MemoryClient['addEventMemoryOnce'] = vi.fn(
      async (input, _providerOperation, beforeProviderAdd) => {
        const existing = await findByEventId(input.id);
        if (existing.results.length > 0)
          return { result: existing, resolution: 'event_lookup' as const };
        await beforeProviderAdd();
        providerAdd();
        rows.set(input.id, { id: 'memory-generic', memory: 'generic inferred fact' });
        throw new Error('crash after inferred add success');
      },
    );
    const handler = buildMemoryEventIngestHandler(
      db,
      {
        send: vi.fn(async (_queue: string, _data: object, options?: object) =>
          options ? deterministicSendId(options) : null,
        ),
      },
      {
        handoffMode: 'write',
        loadEvent: async () => sourceEvent(sourceId),
        memoryClient: memoryClientMock({ addEventMemoryOnce, findByEventId }),
      },
    );

    await expect(handler([ingestJob(sourceId)])).rejects.toThrow(
      /crash after inferred add success/,
    );
    await expect(handler([ingestJob(sourceId)])).resolves.toBeUndefined();
    expect(findByEventId).toHaveBeenCalledTimes(2);
    expect(providerAdd).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
  });

  it('allows a retry to add when the first attempt crashes before the provider boundary', async () => {
    const db = testDb();
    const sourceId = 'generic-pre-boundary-crash';
    let attempts = 0;
    const providerAdd = vi.fn();
    const addEventMemoryOnce: MemoryClient['addEventMemoryOnce'] = vi.fn(
      async (_input, _providerOperation, beforeProviderAdd) => {
        attempts += 1;
        if (attempts === 1) throw new Error('crash before provider boundary');
        await beforeProviderAdd();
        providerAdd();
        return {
          result: { results: [{ id: 'memory-after-retry', memory: 'safe retry' }] },
          resolution: 'provider_result' as const,
        };
      },
    );
    const handler = buildMemoryEventIngestHandler(
      db,
      {
        send: vi.fn(async (_queue: string, _data: object, options?: object) =>
          options ? deterministicSendId(options) : null,
        ),
      },
      {
        handoffMode: 'write',
        loadEvent: async () => sourceEvent(sourceId),
        memoryClient: memoryClientMock({ addEventMemoryOnce }),
      },
    );

    await expect(handler([ingestJob(sourceId)])).rejects.toThrow(/crash before provider boundary/);
    await expect(handler([ingestJob(sourceId)])).resolves.toBeUndefined();
    expect(addEventMemoryOnce).toHaveBeenCalledTimes(2);
    expect(providerAdd).toHaveBeenCalledOnce();
  });
});
