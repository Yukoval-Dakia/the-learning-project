import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient } from './client';
import {
  MEMORY_RECONCILE_QUEUE,
  dispatchMemoryReconcile,
  memoryReconcileJobId,
  recoverMemoryReconcileHandoffs,
} from './memory-reconcile-handoff';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  claimMemoryIngest,
  loadCompleteIntentSet,
  memoryReconcileHandoffEventId,
  persistIngestCompleted,
} from './memory-reconcile-handoff-store';
import { buildMemoryEventIngestHandler } from './triggers';

const first = { id: 'memory-a', text: 'first', created_ms: 1, kind: 'event' };
const second = { id: 'memory-b', text: 'second', created_ms: 2, kind: 'preference' };

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

describe('memory reconcile append-only handoff', () => {
  beforeEach(resetDb);

  it('writes ingest completion plus all intents atomically and preserves exact inputs', async () => {
    const db = testDb();
    await claimMemoryIngest(db, 'source-complete');
    const completion = await persistIngestCompleted(db, {
      sourceEventId: 'source-complete',
      resolution: 'provider_result',
      memories: [second, first],
      persistIntents: true,
    });
    await expect(loadCompleteIntentSet(db, completion)).resolves.toEqual([first, second]);
  });

  it('rolls back completion when one of N deterministic intent rows conflicts', async () => {
    const db = testDb();
    const sourceId = 'source-rollback';
    await claimMemoryIngest(db, sourceId);
    await writeEvent(db, {
      id: memoryReconcileHandoffEventId('reconcile_intent', sourceId, second.id),
      actor_kind: 'system',
      actor_ref: 'test',
      action: MEMORY_RECONCILE_HANDOFF_ACTION,
      subject_kind: 'event',
      subject_id: sourceId,
      outcome: 'success',
      payload: {
        version: 1,
        handoff_kind: 'reconcile_intent',
        source_event_id: sourceId,
        intent_digest: 'f'.repeat(64),
        memory: { ...second, text: 'conflict' },
      },
      ingest_at: new Date(),
    });
    await expect(
      persistIngestCompleted(db, {
        sourceEventId: sourceId,
        resolution: 'provider_result',
        memories: [first, second],
        persistIntents: true,
      }),
    ).rejects.toThrow(/conflicts/);
    const completionRows = await db
      .select()
      .from(event)
      .where(eq(event.id, memoryReconcileHandoffEventId('ingest_completed', sourceId)));
    expect(completionRows).toHaveLength(0);
  });

  it('records an explicit zero-result provider completion without intents', async () => {
    const db = testDb();
    await claimMemoryIngest(db, 'source-zero');
    const completion = await persistIngestCompleted(db, {
      sourceEventId: 'source-zero',
      resolution: 'provider_result',
      memories: [],
      persistIntents: true,
    });
    expect(completion.memory_count).toBe(0);
    await expect(loadCompleteIntentSet(db, completion)).resolves.toEqual([]);
  });

  it('allows event lookup completion without a paid-start marker and requires one for provider results', async () => {
    const db = testDb();
    await expect(
      persistIngestCompleted(db, {
        sourceEventId: 'source-lookup',
        resolution: 'event_lookup',
        memories: [first],
        persistIntents: true,
      }),
    ).resolves.toMatchObject({ resolution: 'event_lookup', memory_count: 1 });
    await expect(
      persistIngestCompleted(db, {
        sourceEventId: 'source-provider-without-marker',
        resolution: 'provider_result',
        memories: [first],
        persistIntents: true,
      }),
    ).rejects.toThrow(/missing or invalid add marker/);
  });

  it('preserves payload/options and confirms a lost send ACK by deterministic readback', async () => {
    const db = testDb();
    const jobId = memoryReconcileJobId('source-ack', [second, first]);
    const boss = {
      send: vi.fn(async () => {
        throw new Error('lost ACK');
      }),
      getJobById: vi.fn(async (_queue: string, id: string) =>
        id === jobId ? { state: 'created' } : null,
      ),
    };
    await expect(
      dispatchMemoryReconcile(db, boss, {
        sourceEventId: 'source-ack',
        memories: [second, first],
      }),
    ).resolves.toBe(jobId);
    expect(boss.send).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      {
        memories: [first, second],
        user_id: 'self',
      },
      {
        id: jobId,
        singletonKey: 'memory.reconcile.self',
        singletonSeconds: 90,
        singletonNextSlot: true,
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      },
    );
  });

  it('propagates send failure when deterministic readback does not confirm the job', async () => {
    const boss = {
      send: vi.fn(async () => {
        throw new Error('send failed');
      }),
      getJobById: vi.fn(async () => null),
    };
    await expect(
      dispatchMemoryReconcile(testDb(), boss, {
        sourceEventId: 'source-failure',
        memories: [first],
      }),
    ).rejects.toThrow('send failed');
  });

  it('rejects a different non-null send id unless exact deterministic readback confirms it', async () => {
    const getJobById = vi.fn(async () => null);
    await expect(
      dispatchMemoryReconcile(
        testDb(),
        { send: vi.fn(async () => 'different-job-id'), getJobById },
        { sourceEventId: 'source-wrong-ack', memories: [first] },
      ),
    ).rejects.toThrow(/enqueue unconfirmed/);
    expect(getJobById).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      memoryReconcileJobId('source-wrong-ack', [first]),
    );
  });

  it('recovers an accepted enqueue by exact failed-state readback without sending again', async () => {
    const db = testDb();
    const sourceId = 'source-crash-before-dispatch-completion';
    await claimMemoryIngest(db, sourceId);
    const completion = await persistIngestCompleted(db, {
      sourceEventId: sourceId,
      resolution: 'provider_result',
      memories: [first],
      persistIntents: true,
    });
    const jobId = memoryReconcileJobId(sourceId, [first]);
    await dispatchMemoryReconcile(
      db,
      { send: vi.fn(async () => jobId) },
      { sourceEventId: sourceId, memories: [first] },
    );
    const send = vi.fn(async () => jobId);
    const getJobById = vi.fn(async () => ({ state: 'failed' }));

    await expect(recoverMemoryReconcileHandoffs(db, { send, getJobById }, 'recover')).resolves.toBe(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    await expect(recoverMemoryReconcileHandoffs(db, { send, getJobById }, 'recover')).resolves.toBe(
      0,
    );
    expect(send).not.toHaveBeenCalled();
    expect(completion.intent_digest).toHaveLength(64);
  });

  it('fails closed when a post-start event lookup is still empty', async () => {
    const db = testDb();
    await claimMemoryIngest(db, 'source-ambiguous');
    const findByEventId = vi.fn(async () => ({ results: [] }));
    const providerAdd = vi.fn();
    const addEventMemoryOnce: MemoryClient['addEventMemoryOnce'] = vi.fn(
      async (input, _providerOperation, beforeProviderAdd) => {
        await findByEventId(input.id);
        await beforeProviderAdd();
        providerAdd();
        return { result: { results: [] }, resolution: 'provider_result' };
      },
    );
    const handler = buildMemoryEventIngestHandler(
      db,
      { send: vi.fn(async () => 'job') },
      {
        loadEvent: async () => ({
          id: 'source-ambiguous',
          actor_kind: 'user',
          action: 'tool_use',
          subject_kind: 'query',
          subject_id: 'query-1',
          payload: {},
          affected_scopes: [],
          created_at: new Date(1),
          kind: 'event',
        }),
        memoryClient: memoryClientMock({ addEventMemoryOnce, findByEventId }),
      },
    );
    await expect(handler([ingestJob('source-ambiguous')])).rejects.toThrow(
      /incomplete or ambiguous/,
    );
    expect(addEventMemoryOnce).toHaveBeenCalledOnce();
    expect(findByEventId).toHaveBeenCalledWith('source-ambiguous');
    expect(providerAdd).not.toHaveBeenCalled();
  });
});
