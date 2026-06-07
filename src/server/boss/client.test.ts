import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetBossForTests, createBoss, getStartedBoss } from './client';

describe('createBoss', () => {
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    _resetBossForTests();
    boss = createBoss();
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, timeout: 1_000 });
    _resetBossForTests();
  });

  it('returns the same PgBoss instance on subsequent calls (singleton)', () => {
    expect(createBoss()).toBe(boss);
  });

  it('round-trips a job via the pgboss.* schema (send → fetch)', async () => {
    const queue = 'test_round_trip';
    await boss.createQueue(queue);
    const jobId = await boss.send(queue, { hello: 'world' });
    expect(typeof jobId).toBe('string');

    const jobs = await boss.fetch(queue);
    expect(jobs).not.toBeNull();
    expect(jobs.length).toBeGreaterThan(0);
    if (jobs.length > 0) {
      expect(jobs[0].data).toEqual({ hello: 'world' });
    }
  });
});

// YUK-259 — getStartedBoss() must survive pg-boss's INTERNAL start-time queue
// create race. pg-boss `boss.start()` directly awaits the timekeeper creating
// its `__pgboss__send-it` queue (index.js start → timekeeper.start →
// manager.createQueue, an `INSERT ... ON CONFLICT DO NOTHING` that can still
// race-raise 23505 `queue_pkey`). That rejection escapes the awaited start()
// (NOT the EventEmitter `error` event), so before the fix it rejected the cached
// startPromise — turning a benign cold-start race into a request-time 500 that
// stuck until the process restarted. These cases mock start() (no live boss
// needed for the new behaviour) to pin the swallow + cache-clear contract.
describe('getStartedBoss — start-time SEND_IT create race (YUK-259)', () => {
  function pgDuplicateQueueError(): Error {
    const err = new Error('duplicate key value violates unique constraint "queue_pkey"');
    Object.assign(err, {
      code: '23505',
      constraint: 'queue_pkey',
      schema: 'pgboss',
      table: 'queue',
      detail: 'Key (name)=(__pgboss__send-it) already exists.',
    });
    return err;
  }

  afterEach(() => {
    _resetBossForTests();
    vi.restoreAllMocks();
  });

  it('swallows a 23505 queue_pkey from boss.start() and resolves to the usable boss', async () => {
    const startSpy = vi.spyOn(PgBoss.prototype, 'start').mockRejectedValue(pgDuplicateQueueError());

    // The whole point of the fix: the benign internal race must NOT reject the
    // cached promise — getStartedBoss resolves to the (already-started) boss.
    const started = await getStartedBoss();
    expect(started).toBeInstanceOf(PgBoss);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Cached: a second call reuses the resolved promise, no second start().
    const again = await getStartedBoss();
    expect(again).toBe(started);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('re-throws a non-23505 start error and clears the cache so a later call retries', async () => {
    const fatal = new Error('connection terminated unexpectedly');
    Object.assign(fatal, { code: '08006' }); // connection_failure, NOT a create race
    const startSpy = vi
      .spyOn(PgBoss.prototype, 'start')
      .mockRejectedValueOnce(fatal)
      .mockResolvedValueOnce(undefined as unknown as PgBoss);

    // A real start failure must surface, not be silently swallowed.
    await expect(getStartedBoss()).rejects.toThrow('connection terminated unexpectedly');

    // ...and the poisoned promise must be cleared so the NEXT call can retry
    // rather than re-rejecting forever from a cached failure.
    const started = await getStartedBoss();
    expect(started).toBeInstanceOf(PgBoss);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
