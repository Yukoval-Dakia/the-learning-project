// ADR-0021 — transactional outbox real-path integration tests.
//
// Per `docs/audit/2026-05-27-wave1-postship-drift.md` W-05: unit-tested
// helpers + missed caller wiring = dead production code. These tests
// exercise the FULL outbox chain on a real Postgres (testcontainer):
//   writeEvent → event.ingest_at NULL → poll handler → boss.send + UPDATE.
// Only `boss.send` is mocked (no pg-boss container required); db + outbox
// SQL (SELECT FOR UPDATE SKIP LOCKED + UPDATE) run for real.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { _resetBossForTests, createBoss } from '../boss/client';
import { MEMORY_EVENT_INGEST_QUEUE, buildMemoryIngestOutboxPollHandler } from './triggers';

function attemptPayload(question_id = 'q1') {
  return {
    actor_kind: 'user' as const,
    actor_ref: 'self',
    action: 'attempt' as const,
    subject_kind: 'question' as const,
    subject_id: question_id,
    outcome: 'failure' as const,
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [] as string[],
      referenced_knowledge_ids: [] as string[],
    },
    created_at: new Date(),
  };
}

describe('outbox poll handler (real-path)', () => {
  let realBoss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    _resetBossForTests();
    realBoss = createBoss();
    await realBoss.start();
    await realBoss.createQueue(MEMORY_EVENT_INGEST_QUEUE);
  });

  afterAll(async () => {
    await realBoss.deleteAllJobs(MEMORY_EVENT_INGEST_QUEUE);
    await realBoss.stop({ graceful: false, timeout: 1_000 });
    _resetBossForTests();
  });

  beforeEach(async () => {
    await resetDb();
    await realBoss.deleteAllJobs(MEMORY_EVENT_INGEST_QUEUE);
  });

  it('tx rollback: writeEvent inside rolled-back tx produces 0 event rows AND 0 ingest jobs', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-x') };
    const id = newId();

    // ADR-0005 single-owner invariant: writeEvent only INSERTs; with the
    // outbox there's no side-effect that escapes the caller tx.
    await expect(
      db.transaction(async (tx) => {
        await writeEvent(tx, { id, ...attemptPayload() });
        throw new Error('caller rolled back');
      }),
    ).rejects.toThrow('caller rolled back');

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(0);

    // Poller sees no pending rows → no enqueue.
    const poll = buildMemoryIngestOutboxPollHandler(db, boss);
    await poll([]);
    expect(boss.send).not.toHaveBeenCalled();
  });
  it('idempotency: writeEvent twice with same id → 1 event row → poll → 1 enqueue', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-1') };
    const id = newId();
    const base = { id, ...attemptPayload() };

    await writeEvent(db, base);
    // onConflictDoNothing — second writeEvent is a no-op; payload not overwritten.
    await writeEvent(db, base);

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].ingest_at).toBeNull();

    const poll = buildMemoryIngestOutboxPollHandler(db, boss);
    await poll([]);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      MEMORY_EVENT_INGEST_QUEUE,
      { event_id: id },
      expect.objectContaining({ db: expect.any(Object) }),
    );
  });

  it('tx rollback: pg-boss send participates in the same poll transaction', async () => {
    const db = testDb();
    const id = newId();
    await writeEvent(db, { id, ...attemptPayload() });
    const boss = {
      send: vi.fn(async (name: string, data: object, options?: object) => {
        await realBoss.send(name, data, options);
        throw new Error('force rollback after transactional send');
      }),
    };

    const poll = buildMemoryIngestOutboxPollHandler(db, boss);
    await expect(poll([])).rejects.toThrow('force rollback after transactional send');

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].ingest_at).toBeNull();
    expect(await realBoss.fetch(MEMORY_EVENT_INGEST_QUEUE)).toHaveLength(0);
  });
});
