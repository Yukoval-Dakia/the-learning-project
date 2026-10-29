import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { dispatchMemoryReconcile } from './memory-reconcile-handoff';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  claimMemoryIngest,
  loadCompleteIntentSet,
  memoryReconcileHandoffEventId,
  persistIngestCompleted,
} from './memory-reconcile-handoff-store';

const first = { id: 'memory-a', text: 'first', created_ms: 1, kind: 'event' };
const second = { id: 'memory-b', text: 'second', created_ms: 2, kind: 'preference' };

describe('memory reconcile append-only handoff', () => {
  beforeEach(resetDb);

  it('writes ingest completion plus all intents atomically and preserves exact inputs', async () => {
    const db = testDb();
    await writeEvent(db, {
      id: 'source-complete',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:memory_handoff_source',
      subject_kind: 'query',
      subject_id: 'handoff-query',
      outcome: 'success',
      payload: { derivation_policy: 'allow' },
      affected_scopes: [],
      ingest_at: new Date(),
    });
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
    await writeEvent(db, {
      id: 'source-rollback',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:memory_handoff_source',
      subject_kind: 'query',
      subject_id: 'handoff-query',
      outcome: 'success',
      payload: { derivation_policy: 'allow' },
      affected_scopes: [],
      ingest_at: new Date(),
    });
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

  it('does not turn a readback error after a null send into an advisory skip', async () => {
    const db = testDb();
    await writeEvent(db, {
      id: 'observe-error',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:memory_handoff_source',
      subject_kind: 'query',
      subject_id: 'handoff-query',
      outcome: 'success',
      payload: { derivation_policy: 'allow' },
      affected_scopes: [],
      ingest_at: new Date(),
    });
    const boss = {
      send: vi.fn(async () => null),
      getJobById: vi.fn(async () => {
        throw new Error('readback offline');
      }),
    };
    await expect(
      dispatchMemoryReconcile(testDb(), boss, {
        sourceEventId: 'observe-error',
        memories: [first],
        mode: 'observe',
      }),
    ).rejects.toThrow('readback offline');
    expect(
      await testDb().select().from(event).where(eq(event.subject_id, 'observe-error')),
    ).toHaveLength(0);
  });
});
