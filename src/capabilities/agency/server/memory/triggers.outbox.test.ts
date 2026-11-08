// ADR-0021 — transactional outbox real-path integration tests.
//
// The poll contract: the unstamped event row is the durable intent, the engine
// send happens after the claim commits under a stable delivery id, and
// `ingest_at` is the acceptance acknowledgement. These tests exercise the full
// chain on a real Postgres + real pg-boss (testcontainer): rollback, the
// crash window between acceptance and stamp, and concurrent drains. Only the
// Mem0-side ingest handler stays out of scope.

import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  MEMORY_EVENT_INGEST_QUEUE,
  buildMemoryIngestOutboxPollHandler,
  enqueueEventMemoryIngest,
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

  // @invariant concurrency: a rolled-back business transaction leaves no
  // intent for the drain to deliver
  // @fails-if the intent write escaped its business transaction — the drained
  // queue would carry a delivery for a business write that never committed
  it('rollback of the business write leaves no intent for the drain', async () => {
    const db = testDb();
    const id = newId();
    await expect(
      db.transaction(async (tx) => {
        await writeEvent(tx, { id, ...attemptPayload() });
        throw new Error('business write aborted');
      }),
    ).rejects.toThrow('business write aborted');

    const boss = { send: vi.fn(realBoss.send.bind(realBoss)) };
    await buildMemoryIngestOutboxPollHandler(db, boss)([]);

    expect(boss.send).not.toHaveBeenCalled();
    expect(await realBoss.fetch(MEMORY_EVENT_INGEST_QUEUE)).toHaveLength(0);
  });

  // @invariant concurrency: an engine-accepted delivery whose
  // stamp never landed replays the identical job, not a second one
  // @fails-if the drain mints a fresh delivery id per pass, or stamps without
  // engine acceptance — the crash window would multiply paid ingest work
  it.each([
    {
      scenario: 'send resolves but the stamp is lost (crash after acceptance)',
      preLand: true,
      expectJobs: 1,
      expectStamped: true,
    },
    {
      scenario: 'engine rejects the send; the row stays pending for the next drain',
      preLand: false,
      expectJobs: 0,
      expectStamped: false,
    },
  ])('$scenario', async ({ preLand, expectJobs, expectStamped }) => {
    const db = testDb();
    const id = newId();
    await writeEvent(db, { id, ...attemptPayload() });
    if (preLand) {
      // Engine already holds this exact delivery; the stamp never landed.
      await enqueueEventMemoryIngest({ send: realBoss.send.bind(realBoss) }, id);
    }

    const boss = preLand
      ? { send: vi.fn(realBoss.send.bind(realBoss)) }
      : {
          send: vi.fn(async () => {
            throw new Error('engine unreachable');
          }),
        };
    await buildMemoryIngestOutboxPollHandler(db, boss)([]);

    const [row] = await db.select().from(event).where(eq(event.id, id));
    expect(await realBoss.fetch(MEMORY_EVENT_INGEST_QUEUE)).toHaveLength(expectJobs);
    expect(row.ingest_at != null).toBe(expectStamped);
    if (preLand) {
      // The replay presented the identical stable id — the engine deduped it.
      expect(boss.send).toHaveBeenCalledTimes(1);
    }
  });

  // @invariant concurrency: two racing pollers partition claims but converge
  // on exactly one engine delivery per row
  // @fails-if overlapping drains can mint a second job for the same event —
  // the paid ingest lane would double-pay under concurrent schedulers
  it('concurrent pollers deliver each pending event exactly once', async () => {
    const db = testDb();
    const ids = [newId(), newId(), newId()];
    for (const id of ids) {
      await writeEvent(db, { id, ...attemptPayload(id) });
    }
    const send = realBoss.send.bind(realBoss);
    const poll = buildMemoryIngestOutboxPollHandler(db, { send });

    await Promise.all([poll([]), poll([])]);

    const jobs = await realBoss.fetch(MEMORY_EVENT_INGEST_QUEUE, { batchSize: 10 });
    expect(jobs).toHaveLength(ids.length);
    const unstamped = await db.select({ id: event.id }).from(event).where(isNull(event.ingest_at));
    expect(unstamped).toHaveLength(0);
  });
});
