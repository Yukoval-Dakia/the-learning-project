import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { MEMORY_RECONCILE_QUEUE, memoryReconcileJobId } from './memory-reconcile-handoff';
import { claimMemoryIngest, persistIngestCompleted } from './memory-reconcile-handoff-store';
import { MEMORY_EVENT_INGEST_QUEUE, buildMemoryIngestOutboxRecoverHandler } from './triggers';

function attemptPayload(questionId: string) {
  return {
    actor_kind: 'user' as const,
    actor_ref: 'self',
    action: 'attempt' as const,
    subject_kind: 'question' as const,
    subject_id: questionId,
    outcome: 'failure' as const,
    payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: new Date(),
  };
}

describe('shared hourly memory recovery handler integration', () => {
  beforeEach(resetDb);

  it('runs both real recovery legs and persists reconcile dispatch confirmation', async () => {
    const db = testDb();
    await writeEvent(db, { id: newId(), ...attemptPayload('q-both-legs') });
    const sourceId = 'reconcile-both-legs';
    const memory = { id: 'memory-both-legs', text: 'fact', created_ms: 1, kind: 'event' };
    await claimMemoryIngest(db, sourceId);
    await persistIngestCompleted(db, {
      sourceEventId: sourceId,
      resolution: 'provider_result',
      memories: [memory],
      persistIntents: true,
    });
    const jobId = memoryReconcileJobId(sourceId, [memory]);
    const send = vi.fn(async (queue: string, _data: object, options?: object) => {
      if (queue !== MEMORY_RECONCILE_QUEUE) return 'ingest-job';
      return options && 'id' in options && options.id === jobId ? jobId : null;
    });

    await buildMemoryIngestOutboxRecoverHandler(db, { send }, 'drain')([]);

    expect(send.mock.calls.some((call) => call[0] === MEMORY_EVENT_INGEST_QUEUE)).toBe(true);
    expect(send.mock.calls.some((call) => call[0] === MEMORY_RECONCILE_QUEUE)).toBe(true);
    expect(await db.select().from(event).where(isNull(event.ingest_at))).toHaveLength(0);
    const sourceRows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, sourceId));
    expect(
      sourceRows.some(
        (row) =>
          row.payload &&
          typeof row.payload === 'object' &&
          'handoff_kind' in row.payload &&
          row.payload.handoff_kind === 'reconcile_dispatch_complete',
      ),
    ).toBe(true);
  });

  it('continues to the real reconcile leg after ingest failure and propagates that failure', async () => {
    const db = testDb();
    await writeEvent(db, { id: newId(), ...attemptPayload('q-ingest-error') });
    const sourceId = 'reconcile-after-ingest-error';
    const memory = { id: 'memory-after-error', text: 'fact', created_ms: 1, kind: 'event' };
    await claimMemoryIngest(db, sourceId);
    await persistIngestCompleted(db, {
      sourceEventId: sourceId,
      resolution: 'provider_result',
      memories: [memory],
      persistIntents: true,
    });
    const jobId = memoryReconcileJobId(sourceId, [memory]);
    const ingestError = new Error('real ingest leg failed');
    const send = vi.fn(async (queue: string) => {
      if (queue === MEMORY_EVENT_INGEST_QUEUE) throw ingestError;
      return jobId;
    });

    await expect(buildMemoryIngestOutboxRecoverHandler(db, { send }, 'drain')([])).rejects.toBe(
      ingestError,
    );
    expect(send.mock.calls.some((call) => call[0] === MEMORY_RECONCILE_QUEUE)).toBe(true);
  });

  it.each([
    { mode: 'observe', runsRecovery: false },
    { mode: 'write', runsRecovery: false },
    { mode: 'recover', runsRecovery: true },
    { mode: 'drain', runsRecovery: true },
  ] as const)('applies $mode backlog recovery semantics in the hourly handler', async (fixture) => {
    const db = testDb();
    const sourceId = `hourly-mode-${fixture.mode}`;
    const memory = {
      id: `memory-${fixture.mode}`,
      text: fixture.mode,
      created_ms: 1,
      kind: 'event',
    };
    await claimMemoryIngest(db, sourceId);
    await persistIngestCompleted(db, {
      sourceEventId: sourceId,
      resolution: 'provider_result',
      memories: [memory],
      persistIntents: true,
    });
    const jobId = memoryReconcileJobId(sourceId, [memory]);
    const send = vi.fn(async (_queue: string) => jobId);

    await buildMemoryIngestOutboxRecoverHandler(db, { send }, fixture.mode)([]);

    expect(send.mock.calls.some((call) => call[0] === MEMORY_RECONCILE_QUEUE)).toBe(
      fixture.runsRecovery,
    );
  });
});
