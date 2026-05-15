import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetBossForTests, createBoss } from './client';

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
