import { randomUUID } from 'node:crypto';

import { PgBoss, type QueueOptions } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeBossJob } from './job-observation';

const TEST_SCHEMA = 'pgboss_yuk596_liveness';

let boss: PgBoss;
let sqlClient: ReturnType<typeof postgres>;
let queueSequence = 0;

async function freshQueue(options: QueueOptions = {}): Promise<string> {
  const queue = `yuk596_liveness_${queueSequence++}`;
  await boss.createQueue(queue, options);
  return queue;
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  boss = new PgBoss({ connectionString, schema: TEST_SCHEMA, max: 2 });
  sqlClient = postgres(connectionString, { max: 1 });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await sqlClient?.end();
});

describe('shared pg-boss job observation contract (YUK-596)', () => {
  it('preserves created/active/completed, retry/failed, cancelled, missing and unknown evidence', async () => {
    const completedQueue = await freshQueue();
    const completedId = randomUUID();
    await boss.send(
      completedQueue,
      { workload: 'cross-subject transfer audit' },
      { id: completedId },
    );
    await expect(observeBossJob(completedQueue, completedId, { boss })).resolves.toMatchObject({
      kind: 'live',
      state: 'created',
    });
    await boss.fetch(completedQueue);
    await expect(observeBossJob(completedQueue, completedId, { boss })).resolves.toMatchObject({
      kind: 'live',
      state: 'active',
    });
    await boss.complete(completedQueue, completedId);
    await expect(observeBossJob(completedQueue, completedId, { boss })).resolves.toMatchObject({
      kind: 'settled',
      state: 'completed',
    });

    const retryQueue = await freshQueue({ retryLimit: 1 });
    const retryId = randomUUID();
    await boss.send(retryQueue, { checked_answers: 31, total_answers: 48 }, { id: retryId });
    await boss.fetch(retryQueue);
    await boss.fail(retryQueue, retryId, { message: 'transient provider reset' });
    await expect(observeBossJob(retryQueue, retryId, { boss })).resolves.toMatchObject({
      kind: 'live',
      state: 'retry',
    });

    const failedQueue = await freshQueue({ retryLimit: 0 });
    const failedId = randomUUID();
    await boss.send(failedQueue, { probes: 6, variants: 9 }, { id: failedId });
    await boss.fetch(failedQueue);
    await boss.fail(failedQueue, failedId, { message: 'delivery budget exhausted' });
    await expect(observeBossJob(failedQueue, failedId, { boss })).resolves.toMatchObject({
      kind: 'settled',
      state: 'failed',
    });

    const cancelledQueue = await freshQueue();
    const cancelledId = randomUUID();
    await boss.send(
      cancelledQueue,
      { operation: 'owner cancelled before pickup' },
      { id: cancelledId },
    );
    await boss.cancel(cancelledQueue, cancelledId);
    await expect(observeBossJob(cancelledQueue, cancelledId, { boss })).resolves.toMatchObject({
      kind: 'settled',
      state: 'cancelled',
    });

    await expect(observeBossJob(cancelledQueue, randomUUID(), { boss })).resolves.toEqual({
      kind: 'missing',
    });
    const lookupError = new Error('pg-boss lookup unavailable');
    await expect(
      observeBossJob(cancelledQueue, randomUUID(), {
        boss: { getJobById: async () => Promise.reject(lookupError) },
      }),
    ).resolves.toEqual({ kind: 'unknown', error: lookupError });
  });

  it('reports a real batchSize:1 busy queue instead of assuming the waiting job is unavailable', async () => {
    const queue = await freshQueue();
    const activeId = randomUUID();
    const waitingId = randomUUID();
    await boss.send(queue, { task: 'validate 48 historical answers' }, { id: activeId });
    await boss.send(queue, { task: 'author nine transfer variants' }, { id: waitingId });
    await boss.fetch(queue, { batchSize: 1 });

    const stats = (await boss.getQueueStats(queue, { force: true }))[0];
    expect(stats).toMatchObject({ activeCount: 1 });
    await expect(observeBossJob(queue, waitingId, { boss })).resolves.toMatchObject({
      kind: 'live',
      state: 'created',
    });
  });

  it('queue heartbeat converts a crashed active delivery into settled failure evidence', async () => {
    const queue = await freshQueue({ heartbeatSeconds: 10, retryLimit: 0 });
    const jobId = randomUUID();
    await boss.send(
      queue,
      { task: 'rebuild a six-probe transfer gradient without duplicate tool writes' },
      { id: jobId },
    );
    await boss.fetch(queue);
    const active = await boss.getJobById(queue, jobId);
    expect(active).toMatchObject({ state: 'active', heartbeatSeconds: 10 });

    await sqlClient.unsafe(
      `UPDATE "${TEST_SCHEMA}".job SET heartbeat_on = now() - interval '30 seconds' WHERE id = $1`,
      [jobId],
    );
    await boss.supervise(queue);

    await expect(observeBossJob(queue, jobId, { boss })).resolves.toMatchObject({
      kind: 'settled',
      state: 'failed',
    });
  });
});
