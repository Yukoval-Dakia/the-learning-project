// ADR-0021 — transactional outbox real-path integration tests.
//
// Per `docs/audit/2026-05-27-wave1-postship-drift.md` W-05: unit-tested
// helpers + missed caller wiring = dead production code. These tests
// exercise the FULL outbox chain on a real Postgres (testcontainer):
//   writeEvent → event.ingest_at NULL → poll handler → boss.send + UPDATE.
// Only `boss.send` is mocked (no pg-boss container required); db + outbox
// SQL (SELECT FOR UPDATE SKIP LOCKED + UPDATE) run for real.

import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeEvent } from '../events/queries';
import {
  MEMORY_EVENT_INGEST_QUEUE,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
} from './triggers';

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
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path: writeEvent leaves ingest_at NULL; poll enqueues + stamps in one tx', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-1') };
    const id = newId();
    await writeEvent(db, { id, ...attemptPayload() });

    const before = await db.select().from(event).where(eq(event.id, id));
    expect(before).toHaveLength(1);
    expect(before[0].ingest_at).toBeNull();

    const poll = buildMemoryIngestOutboxPollHandler(db, boss);
    await poll([]);

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(MEMORY_EVENT_INGEST_QUEUE, { event_id: id });

    const after = await db.select().from(event).where(eq(event.id, id));
    expect(after[0].ingest_at).not.toBeNull();
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
    expect(boss.send).toHaveBeenCalledWith(MEMORY_EVENT_INGEST_QUEUE, { event_id: id });
  });

  it('batch limit: poll handler drains up to OUTBOX_POLL_BATCH per invocation', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-x') };
    const ids: string[] = [];
    // Seed 75 pending rows (> batch=50).
    for (let i = 0; i < 75; i += 1) {
      const id = newId();
      ids.push(id);
      await writeEvent(db, { id, ...attemptPayload(`q-${i}`) });
    }

    const poll = buildMemoryIngestOutboxPollHandler(db, boss);
    await poll([]);

    expect(boss.send).toHaveBeenCalledTimes(50);
    const remaining = await db.select().from(event).where(isNull(event.ingest_at));
    expect(remaining).toHaveLength(25);
  });
});

describe('outbox recovery handler (real-path)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('drains all pending rows across multiple batch cycles', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-x') };
    for (let i = 0; i < 75; i += 1) {
      await writeEvent(db, { id: newId(), ...attemptPayload(`q-${i}`) });
    }

    const recover = buildMemoryIngestOutboxRecoverHandler(db, boss);
    await recover([]);

    expect(boss.send).toHaveBeenCalledTimes(75);
    const remaining = await db.select().from(event).where(isNull(event.ingest_at));
    expect(remaining).toHaveLength(0);
  });

  it('exits cleanly when no pending rows', async () => {
    const db = testDb();
    const boss = { send: vi.fn(async () => 'job-x') };
    const recover = buildMemoryIngestOutboxRecoverHandler(db, boss);
    await recover([]);
    expect(boss.send).not.toHaveBeenCalled();
  });
});
