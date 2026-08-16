import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryReconcileJobId, recoverMemoryReconcileHandoffs } from './memory-reconcile-handoff';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  claimMemoryIngest,
  persistIngestCompleted,
} from './memory-reconcile-handoff-store';

const first = { id: 'memory-a', text: 'first', created_ms: 1, kind: 'event' };

function deterministicSendId(options: object): string | null {
  return 'id' in options && typeof options.id === 'string' ? options.id : null;
}

describe('memory reconcile recovery scan', () => {
  beforeEach(resetDb);

  it('pre-filters future/malformed rows and skips stale incomplete sets without starving valid recovery', async () => {
    const db = testDb();
    for (const fixture of [
      { id: 'malformed', payload: { version: 1, handoff_kind: 'ingest_completed' } },
      { id: 'future', payload: { version: 2, handoff_kind: 'ingest_completed', memory_count: 1 } },
    ])
      await writeEvent(db, {
        id: fixture.id,
        actor_kind: 'system',
        actor_ref: 'test',
        action: MEMORY_RECONCILE_HANDOFF_ACTION,
        subject_kind: 'event',
        subject_id: fixture.id,
        outcome: 'success',
        payload: fixture.payload,
        ingest_at: new Date(),
      });
    await claimMemoryIngest(db, 'stale');
    await persistIngestCompleted(db, {
      sourceEventId: 'stale',
      resolution: 'provider_result',
      memories: [first],
      persistIntents: false,
    });
    await claimMemoryIngest(db, 'valid');
    await persistIngestCompleted(db, {
      sourceEventId: 'valid',
      resolution: 'provider_result',
      memories: [first],
      persistIntents: true,
    });
    const send = vi.fn(async (_queue: string, _data: object, options: object) =>
      deterministicSendId(options),
    );

    await expect(recoverMemoryReconcileHandoffs(db, { send }, 'drain')).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pages past a full earlier page of failing candidates to dispatch a later healthy candidate', async () => {
    const db = testDb();
    for (let index = 0; index < 26; index += 1) {
      const sourceId = `paged-${index.toString().padStart(2, '0')}`;
      await claimMemoryIngest(db, sourceId);
      await persistIngestCompleted(db, {
        sourceEventId: sourceId,
        resolution: 'provider_result',
        memories: [{ ...first, id: `memory-${sourceId}` }],
        persistIntents: true,
      });
    }
    const healthySourceId = 'paged-25';
    const healthyMemory = { ...first, id: `memory-${healthySourceId}` };
    const healthyJobId = memoryReconcileJobId(healthySourceId, [healthyMemory]);
    const send = vi.fn(async (_queue: string, _data: object, options: object) => {
      const id = deterministicSendId(options);
      if (id === healthyJobId) return id;
      throw new Error(`candidate dispatch failed ${id}`);
    });

    await expect(recoverMemoryReconcileHandoffs(db, { send }, 'recover')).rejects.toThrow(
      /candidate dispatch failed/,
    );
    expect(send.mock.calls.some((call) => deterministicSendId(call[2]) === healthyJobId)).toBe(
      true,
    );
    const healthyRows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, healthySourceId));
    expect(
      healthyRows.some(
        (row) =>
          row.payload &&
          typeof row.payload === 'object' &&
          'handoff_kind' in row.payload &&
          row.payload.handoff_kind === 'reconcile_dispatch_complete',
      ),
    ).toBe(true);
  });
});
