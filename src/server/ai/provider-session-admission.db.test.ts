import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { provider_session_admission } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PROVIDER_SESSION_ABORT_GRACE_MS,
  PROVIDER_SESSION_HEARTBEAT_MS,
  PROVIDER_SESSION_INITIAL_LEASE_TTL_MS,
  PROVIDER_SESSION_LEASE_TTL_MS,
  type ProviderSessionAdmissionPlan,
  acquireProviderSession,
} from './provider-session-admission';

const BASE_POLICY = {
  laneId: 'xiaomi' as const,
  maxConcurrentSessions: 1,
  maxSessionStartsPerMinute: 100,
  maxQueuedSessions: 10,
  maxWaitMs: 2_000,
  fingerprint: 'test-policy-v1',
};

type ActivePlan = Exclude<ProviderSessionAdmissionPlan, { mode: 'off' }>;

const ASYNC_EVENT_TIMEOUT_MS = PROVIDER_SESSION_HEARTBEAT_MS * 2 + 2_000;
const LEASE_TIMING_TOLERANCE_MS = 2_000;

interface IndependentDb {
  db: Db;
  close(): Promise<void>;
}

const opened: IndependentDb[] = [];
const controllers: AbortController[] = [];
const permits: Array<{ release(): Promise<void> }> = [];
const pending: Promise<unknown>[] = [];

function openIndependentDb(): IndependentDb {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const handle = {
    db: drizzle(client, { schema }) as unknown as Db,
    close: () => client.end(),
  };
  opened.push(handle);
  return handle;
}

function plan(
  overrides: Partial<typeof BASE_POLICY> = {},
  mode: ActivePlan['mode'] = 'enforce',
): ActivePlan {
  return { mode, laneId: 'xiaomi', policy: { ...BASE_POLICY, ...overrides } };
}

function startAcquire(input: {
  db: Db;
  taskRunId: string;
  admissionPlan?: ActivePlan;
  parentTaskRunId?: string;
  executionTimeoutMs?: number;
}) {
  const controller = new AbortController();
  controllers.push(controller);
  const promise = acquireProviderSession({
    db: input.db,
    kind: 'AttributionTask',
    taskRunId: input.taskRunId,
    parentTaskRunId: input.parentTaskRunId,
    executionTimeoutMs: input.executionTimeoutMs ?? 1_000,
    signal: controller.signal,
    plan: input.admissionPlan ?? plan(),
    onLeaseLost: () => controller.abort(),
  }).then((permit) => {
    permits.push(permit);
    return permit;
  });
  pending.push(promise);
  return promise;
}

async function waitForStatus(taskRunId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await testDb()
      .select({ status: provider_session_admission.status })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, taskRunId));
    if (rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`admission ${taskRunId} did not reach status=${status}`);
}

interface LeaseSnapshot {
  mode: 'observe' | 'enforce';
  acquiredAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
  hardReclaimAt: Date;
}

async function readLeaseSnapshot(taskRunId: string): Promise<LeaseSnapshot> {
  const rows = await testDb()
    .select({
      mode: provider_session_admission.mode,
      acquiredAt: provider_session_admission.acquired_at,
      heartbeatAt: provider_session_admission.heartbeat_at,
      leaseExpiresAt: provider_session_admission.lease_expires_at,
      hardReclaimAt: provider_session_admission.hard_reclaim_at,
    })
    .from(provider_session_admission)
    .where(eq(provider_session_admission.task_run_id, taskRunId));
  const row = rows[0];
  if (!row?.acquiredAt || !row.heartbeatAt || !row.leaseExpiresAt || !row.hardReclaimAt) {
    throw new Error(`admission ${taskRunId} has no complete lease snapshot`);
  }
  return {
    mode: row.mode,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    hardReclaimAt: row.hardReclaimAt,
  };
}

async function waitForHeartbeatAfter(taskRunId: string, prior: Date): Promise<LeaseSnapshot> {
  const deadline = Date.now() + ASYNC_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await readLeaseSnapshot(taskRunId);
    if (snapshot.heartbeatAt.getTime() > prior.getTime()) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`admission ${taskRunId} heartbeat did not advance`);
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ASYNC_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('provider session heartbeat did not fence the lost owner');
}

function expectDurationNear(actualMs: number, expectedMs: number): void {
  expect(actualMs).toBeGreaterThanOrEqual(expectedMs - LEASE_TIMING_TOLERANCE_MS);
  expect(actualMs).toBeLessThanOrEqual(expectedMs + LEASE_TIMING_TOLERANCE_MS);
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(permits.splice(0).map((permit) => permit.release()));
  await Promise.allSettled(pending.splice(0));
  await Promise.allSettled(opened.splice(0).map((handle) => handle.close()));
});

describe('YUK-842 cross-process provider SDK-session admission', () => {
  it.each(['observe', 'enforce'] as const)(
    'starts %s sessions with the distinct SDK-startup lease',
    async (mode) => {
      const a = openIndependentDb();
      const taskRunId = `startup-lease-${mode}`;
      const permit = await startAcquire({
        db: a.db,
        taskRunId,
        admissionPlan: plan({}, mode),
        executionTimeoutMs: 120_000,
      });

      const row = await readLeaseSnapshot(taskRunId);
      expect(row.mode).toBe(mode);
      expectDurationNear(
        row.leaseExpiresAt.getTime() - row.heartbeatAt.getTime(),
        PROVIDER_SESSION_INITIAL_LEASE_TTL_MS,
      );
      expectDurationNear(
        row.hardReclaimAt.getTime() - row.acquiredAt.getTime(),
        PROVIDER_SESSION_INITIAL_LEASE_TTL_MS + 120_000 + PROVIDER_SESSION_ABORT_GRACE_MS,
      );
      expect(row.leaseExpiresAt.getTime()).toBeLessThan(row.hardReclaimAt.getTime());

      await permit.completeStartup();
      const steady = await readLeaseSnapshot(taskRunId);
      expectDurationNear(
        steady.leaseExpiresAt.getTime() - steady.heartbeatAt.getTime(),
        PROVIDER_SESSION_LEASE_TTL_MS,
      );
      expect(steady.leaseExpiresAt.getTime()).toBeLessThanOrEqual(steady.hardReclaimAt.getTime());
    },
  );

  it('fails closed when startup completion cannot confirm its claim fence', async () => {
    const a = openIndependentDb();
    const permit = await startAcquire({
      db: a.db,
      taskRunId: 'startup-completion-fence-lost',
    });
    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET claim_token = gen_random_uuid()
       WHERE task_run_id = 'startup-completion-fence-lost'
    `);

    await expect(permit.completeStartup()).rejects.toMatchObject({ reason: 'lease_lost' });
    expect(controllers.at(-1)?.signal.aborted).toBe(true);
  });

  it.each(['observe', 'enforce'] as const)(
    'bounds an indeterminate %s startup transition without waiting for the pool blocker',
    async (mode) => {
      const a = openIndependentDb();
      const taskRunId = `startup-transition-pool-${mode}`;
      const permit = await startAcquire({
        db: a.db,
        taskRunId,
        admissionPlan: plan({}, mode),
      });

      let unblock!: () => void;
      const hold = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let markBlocked!: () => void;
      const blocked = new Promise<void>((resolve) => {
        markBlocked = resolve;
      });
      const blocker = a.db.transaction(async () => {
        markBlocked();
        await hold;
      });
      await blocked;

      try {
        const completion = permit.completeStartup();
        if (mode === 'enforce') {
          await expect(completion).rejects.toMatchObject({
            reason: 'control_plane_unavailable',
          });
        } else {
          await expect(completion).resolves.toBeUndefined();
        }
      } finally {
        unblock();
        await blocker;
      }

      if (mode === 'observe') {
        const initial = await readLeaseSnapshot(taskRunId);
        const steady = await waitForHeartbeatAfter(taskRunId, initial.heartbeatAt);
        expectDurationNear(
          steady.leaseExpiresAt.getTime() - steady.heartbeatAt.getTime(),
          PROVIDER_SESSION_LEASE_TTL_MS,
        );
      }
    },
  );

  it('keeps the startup phase inside hard reclaim for a short execution budget', async () => {
    const a = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'short-execution-startup-lease' });

    const row = await readLeaseSnapshot('short-execution-startup-lease');
    expectDurationNear(
      row.leaseExpiresAt.getTime() - row.heartbeatAt.getTime(),
      PROVIDER_SESSION_INITIAL_LEASE_TTL_MS,
    );
    expectDurationNear(
      row.hardReclaimAt.getTime() - row.acquiredAt.getTime(),
      PROVIDER_SESSION_INITIAL_LEASE_TTL_MS + 1_000 + PROVIDER_SESSION_ABORT_GRACE_MS,
    );
    expect(row.leaseExpiresAt.getTime()).toBeLessThan(row.hardReclaimAt.getTime());
  });

  it('shares one concurrency cap across two independent DB clients', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const first = await startAcquire({ db: a.db, taskRunId: 'session-a' });
    const secondPromise = startAcquire({ db: b.db, taskRunId: 'session-b' });

    await waitForStatus('session-b', 'waiting');
    await first.release();
    const second = await secondPromise;

    expect(second.borrowedFromTaskRunId).toBeNull();
    await waitForStatus('session-b', 'acquired');
  });

  it('admits ordinary waiters in persisted FIFO order', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const holder = await startAcquire({ db: a.db, taskRunId: 'fifo-holder' });
    const firstPromise = startAcquire({ db: a.db, taskRunId: 'fifo-first' });
    await waitForStatus('fifo-first', 'waiting');
    const secondPromise = startAcquire({ db: b.db, taskRunId: 'fifo-second' });
    await waitForStatus('fifo-second', 'waiting');

    await holder.release();
    const first = await firstPromise;
    await waitForStatus('fifo-first', 'acquired');
    await waitForStatus('fifo-second', 'waiting');
    await first.release();
    await secondPromise;
    await waitForStatus('fifo-second', 'acquired');
  });

  it('rejects above the configured durable queue bound', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const queuePlan = plan({ maxQueuedSessions: 1 });
    await startAcquire({ db: a.db, taskRunId: 'queue-holder', admissionPlan: queuePlan });
    startAcquire({ db: a.db, taskRunId: 'queue-waiter', admissionPlan: queuePlan });
    await waitForStatus('queue-waiter', 'waiting');

    await expect(
      startAcquire({ db: b.db, taskRunId: 'queue-rejected', admissionPlan: queuePlan }),
    ).rejects.toMatchObject({ reason: 'queue_full' });
    await waitForStatus('queue-rejected', 'rejected');
  });

  it('never lets a duplicate process inherit another owner claim', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'duplicate-session' });

    await expect(startAcquire({ db: b.db, taskRunId: 'duplicate-session' })).rejects.toMatchObject({
      reason: 'control_plane_unavailable',
    });
    const rows = await testDb()
      .select({ status: provider_session_admission.status })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, 'duplicate-session'));
    expect(rows).toEqual([{ status: 'acquired' }]);
  });

  it('retries an indeterminate heartbeat within the live lease but fences an explicit claim loss', async () => {
    const a = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'heartbeat-indeterminate' });
    const controller = controllers.at(-1);
    if (!controller) throw new Error('heartbeat test controller missing');
    const initial = await readLeaseSnapshot('heartbeat-indeterminate');
    const transactionSpy = vi.spyOn(a.db, 'transaction');

    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    // This independent handle has max=1. Occupying it across the first 5s
    // heartbeat forces boundedAdmissionTransaction to return indeterminate;
    // the persisted lease itself remains live in Postgres.
    const blocker = a.db.transaction(async () => {
      markBlocked();
      await hold;
    });
    try {
      try {
        await blocked;
        const heartbeatQueuedDeadline = Date.now() + PROVIDER_SESSION_HEARTBEAT_MS + 2_000;
        while (transactionSpy.mock.calls.length < 2 && Date.now() < heartbeatQueuedDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(transactionSpy).toHaveBeenCalledTimes(2);
        // Start this wait only after observing the heartbeat transaction enter the
        // pool queue. It therefore proves the 1s operation budget elapsed even if
        // the CI event loop delivered the original 5s timer late.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(controller.signal.aborted).toBe(false);
        // One call holds the only pool connection; one heartbeat is queued behind
        // it. No short retry may enqueue a third transaction until that underlying
        // expired callback has actually settled.
        expect(transactionSpy).toHaveBeenCalledTimes(2);
      } finally {
        unblock();
        await blocker;
      }

      const renewed = await waitForHeartbeatAfter('heartbeat-indeterminate', initial.heartbeatAt);
      expect(controller.signal.aborted).toBe(false);
      expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
        initial.leaseExpiresAt.getTime() - 1,
      );

      // A completed zero-row CAS is different from an indeterminate DB budget:
      // it proves this claim token no longer owns the lease and must fence now.
      await testDb().execute(sql`
        UPDATE provider_session_admission
           SET claim_token = gen_random_uuid()
         WHERE task_run_id = 'heartbeat-indeterminate'
      `);
      await waitForAbort(controller.signal);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('extends a near-expiry live lease by the steady renewal horizon', async () => {
    const a = openIndependentDb();
    const permit = await startAcquire({
      db: a.db,
      taskRunId: 'steady-renewal-horizon',
      executionTimeoutMs: 120_000,
    });
    await permit.completeStartup();
    const initial = await readLeaseSnapshot('steady-renewal-horizon');
    const forcedRows = await testDb().execute<{ lease_expires_at: Date }>(sql`
      UPDATE provider_session_admission
         SET lease_expires_at = clock_timestamp() + interval '12 seconds'
       WHERE task_run_id = 'steady-renewal-horizon'
         AND status = 'acquired'
         AND hard_reclaim_at > clock_timestamp() + interval '12 seconds'
      RETURNING lease_expires_at
    `);
    const forcedExpiry = forcedRows[0]?.lease_expires_at;
    if (!forcedExpiry) throw new Error('steady renewal fixture did not update the live lease');

    const renewed = await waitForHeartbeatAfter('steady-renewal-horizon', initial.heartbeatAt);
    expectDurationNear(
      renewed.leaseExpiresAt.getTime() - renewed.heartbeatAt.getTime(),
      PROVIDER_SESSION_LEASE_TTL_MS,
    );
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(
      forcedExpiry.getTime() + LEASE_TIMING_TOLERANCE_MS,
    );
    expect(renewed.leaseExpiresAt.getTime()).toBeLessThanOrEqual(renewed.hardReclaimAt.getTime());
  });

  it('fails closed instead of operating on a same-id waiter from another lane', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'cross-lane-holder' });
    startAcquire({ db: a.db, taskRunId: 'cross-lane-collision' });
    await waitForStatus('cross-lane-collision', 'waiting');
    const anthropicPlan: ActivePlan = {
      mode: 'enforce',
      laneId: 'anthropic',
      policy: {
        ...BASE_POLICY,
        laneId: 'anthropic',
        fingerprint: 'anthropic-policy-v1',
      },
    };

    await expect(
      startAcquire({
        db: b.db,
        taskRunId: 'cross-lane-collision',
        admissionPlan: anthropicPlan,
      }),
    ).rejects.toMatchObject({ reason: 'control_plane_unavailable' });
    const rows = await testDb()
      .select({ laneId: provider_session_admission.lane_id })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, 'cross-lane-collision'));
    expect(rows).toEqual([{ laneId: 'xiaomi' }]);
  });

  it('quarantines an expired owner until hard reclaim, then recovers capacity', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'stale-owner' });
    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET requested_at = clock_timestamp() - interval '3 seconds',
             acquired_at = clock_timestamp() - interval '2500 milliseconds',
             heartbeat_at = clock_timestamp() - interval '2 seconds',
             lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE task_run_id = 'stale-owner'
    `);

    const successorPromise = startAcquire({ db: b.db, taskRunId: 'stale-successor' });
    await waitForStatus('stale-owner', 'lease_expired');
    await waitForStatus('stale-successor', 'waiting');

    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET hard_reclaim_at = clock_timestamp() - interval '1 millisecond'
       WHERE task_run_id = 'stale-owner'
    `);
    await successorPromise;
    await waitForStatus('stale-successor', 'acquired');
  });

  it('borrows an active same-lane parent slot without releasing the parent capacity', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const parent = await startAcquire({ db: a.db, taskRunId: 'outer-session' });
    const child = await startAcquire({
      db: b.db,
      taskRunId: 'inner-session',
      parentTaskRunId: 'outer-session',
    });

    expect(child.borrowedFromTaskRunId).toBe('outer-session');
    const outsiderPromise = startAcquire({ db: b.db, taskRunId: 'unrelated-session' });
    await waitForStatus('unrelated-session', 'waiting');
    await child.release();
    await waitForStatus('unrelated-session', 'waiting');

    await parent.release();
    const outsider = await outsiderPromise;
    expect(outsider.borrowedFromTaskRunId).toBeNull();
  });

  it('serializes parallel borrowed siblings when the family owns the only slot', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'parallel-parent' });
    const firstChild = await startAcquire({
      db: b.db,
      taskRunId: 'parallel-child-a',
      parentTaskRunId: 'parallel-parent',
    });
    const secondChildPromise = startAcquire({
      db: a.db,
      taskRunId: 'parallel-child-b',
      parentTaskRunId: 'parallel-parent',
    });

    await waitForStatus('parallel-child-b', 'waiting');
    await firstChild.release();
    const secondChild = await secondChildPromise;
    expect(secondChild.borrowedFromTaskRunId).toBe('parallel-parent');
  });

  it('makes a borrowed child occupy the family slot when its parent releases first', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const parent = await startAcquire({ db: a.db, taskRunId: 'parent-first-parent' });
    const child = await startAcquire({
      db: b.db,
      taskRunId: 'parent-first-child',
      parentTaskRunId: 'parent-first-parent',
    });

    await parent.release();
    const outsiderPromise = startAcquire({ db: a.db, taskRunId: 'parent-first-outsider' });
    await waitForStatus('parent-first-outsider', 'waiting');
    await child.release();
    const outsider = await outsiderPromise;
    expect(outsider.borrowedFromTaskRunId).toBeNull();
  });

  it('charges a released start reservation to the persisted rate window', async () => {
    const a = openIndependentDb();
    const ratePlan = plan({ maxConcurrentSessions: 5, maxSessionStartsPerMinute: 1 });
    const first = await startAcquire({
      db: a.db,
      taskRunId: 'rate-first',
      admissionPlan: ratePlan,
    });
    await first.release();

    const secondPromise = startAcquire({
      db: a.db,
      taskRunId: 'rate-second',
      admissionPlan: ratePlan,
    });
    await waitForStatus('rate-second', 'waiting');
    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET requested_at = clock_timestamp() - interval '62 seconds',
             acquired_at = clock_timestamp() - interval '61 seconds',
             heartbeat_at = clock_timestamp() - interval '61 seconds',
             lease_expires_at = clock_timestamp() - interval '60 seconds',
             hard_reclaim_at = clock_timestamp() - interval '59 seconds',
             terminal_at = clock_timestamp() - interval '59 seconds'
       WHERE task_run_id = 'rate-first'
    `);
    await secondPromise;
    await waitForStatus('rate-second', 'acquired');
  });

  it('charges a borrowed child as its own persisted start reservation', async () => {
    const a = openIndependentDb();
    const ratePlan = plan({ maxSessionStartsPerMinute: 2 });
    const parent = await startAcquire({
      db: a.db,
      taskRunId: 'borrowed-rate-parent',
      admissionPlan: ratePlan,
    });
    const child = await startAcquire({
      db: a.db,
      taskRunId: 'borrowed-rate-child',
      parentTaskRunId: 'borrowed-rate-parent',
      admissionPlan: ratePlan,
    });
    await child.release();
    await parent.release();

    const nextPromise = startAcquire({
      db: a.db,
      taskRunId: 'borrowed-rate-next',
      admissionPlan: ratePlan,
    });
    await waitForStatus('borrowed-rate-next', 'waiting');
    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET requested_at = clock_timestamp() - interval '62 seconds',
             acquired_at = clock_timestamp() - interval '61 seconds',
             heartbeat_at = clock_timestamp() - interval '61 seconds',
             lease_expires_at = clock_timestamp() - interval '60 seconds',
             hard_reclaim_at = clock_timestamp() - interval '59 seconds',
             terminal_at = clock_timestamp() - interval '59 seconds'
       WHERE task_run_id IN ('borrowed-rate-parent', 'borrowed-rate-child')
    `);
    await nextPromise;
    await waitForStatus('borrowed-rate-next', 'acquired');
  });

  it('fails closed on overlapping active policy fingerprints', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'old-policy' });

    await expect(
      startAcquire({
        db: b.db,
        taskRunId: 'new-policy',
        admissionPlan: plan({ fingerprint: 'test-policy-v2' }),
      }),
    ).rejects.toMatchObject({ reason: 'policy_mismatch' });
    await waitForStatus('new-policy', 'rejected');
  });

  it('linearizes bounded wait timeout in the DB and never acquires afterward', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    const timeoutPlan = plan({ maxWaitMs: 250 });
    await startAcquire({
      db: a.db,
      taskRunId: 'timeout-holder',
      admissionPlan: timeoutPlan,
    });

    await expect(
      startAcquire({
        db: b.db,
        taskRunId: 'timeout-waiter',
        admissionPlan: timeoutPlan,
      }),
    ).rejects.toMatchObject({ reason: 'wait_timeout' });
    const rows = await testDb()
      .select({ status: provider_session_admission.status })
      .from(provider_session_admission)
      .where(eq(provider_session_admission.task_run_id, 'timeout-waiter'));
    expect(rows).toEqual([{ status: 'timed_out' }]);
  });

  it('bounds a lane sweep blocked on a row lock at the DB layer', async () => {
    const a = openIndependentDb();
    const b = openIndependentDb();
    await startAcquire({ db: a.db, taskRunId: 'db-lock-stale-owner' });
    await testDb().execute(sql`
      UPDATE provider_session_admission
         SET requested_at = clock_timestamp() - interval '3 seconds',
             acquired_at = clock_timestamp() - interval '2500 milliseconds',
             heartbeat_at = clock_timestamp() - interval '2 seconds',
             lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE task_run_id = 'db-lock-stale-owner'
    `);

    let unlock!: () => void;
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = a.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT task_run_id
          FROM provider_session_admission
         WHERE task_run_id = 'db-lock-stale-owner'
         FOR UPDATE
      `);
      locked();
      await hold;
    });
    await rowLocked;

    try {
      await expect(
        startAcquire({
          db: b.db,
          taskRunId: 'db-lock-bounded-waiter',
          admissionPlan: plan({ maxWaitMs: 400 }),
        }),
      ).rejects.toMatchObject({ reason: 'wait_timeout' });
    } finally {
      unlock();
      await blocker;
    }
  });
});
