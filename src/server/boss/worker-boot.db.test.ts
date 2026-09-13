// YUK-980 — startup-tail graceful shutdown regression, at the REAL worker boot
// lifecycle seam.
//
// Pre-fix wiring (C1, 67d43df12): scripts/worker.ts kept `let boss = null` and
// only assigned it AFTER `await startBossWorker(db)` returned. But
// startBossWorker calls markBossStarted() and mounts consumers (registerHandlers)
// long before it returns — the whole registration tail (registerCapabilityJobs →
// reconcileStuckAiTaskRuns) runs with consumers already polling. A SIGTERM in
// that window hit installBootShutdownHandler's null-boss branch: exit(1) with
// "no jobs drainable" — FALSE while a job is in flight, and the in-flight job
// was cut off without the graceful drain.
//
// This file drives the production lifecycle owner (bootWorker — extracted from
// scripts/worker.ts exactly so this seam is testable) against the fork's real
// migrated Postgres: real createBoss/start/markBossStarted, REAL
// registerHandlers consumers (echo + housekeeping + memory + verify recovery),
// real startup tail steps, real stopBossGracefully drain. Exactly TWO leaf
// seams are vi.mock'd for deterministic pacing, neither of which is the code
// under test:
//   - registerCapabilityJobs: the deferred gate that holds the boot INSIDE the
//     startup tail (after consumers are mounted, before startBossWorker
//     resolves) — the production mid-registration window;
//   - recoverToolOperationsOnBoot: the deferred gate for the pre-consumption
//     window (before createBoss/boss.start).
// The in-flight task is a real pg-boss job on the real started boss whose
// handler blocks on a test-controlled gate; drain evidence is the job row
// reaching state='completed' in pgboss.job.

import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverToolOperationsOnBoot } from '@/kernel/tools/tool-operations';
import { resetDb } from '../../../tests/helpers/db';
import { _resetBossForTests, getRunningBoss } from './client';
import { registerCapabilityJobs } from './register-capability-jobs';
import { bootWorker } from './worker-boot';

vi.mock('@/server/boss/register-capability-jobs', () => ({
  registerCapabilityJobs: vi.fn(async () => undefined),
}));
vi.mock('@/kernel/tools/tool-operations', () => ({
  recoverToolOperationsOnBoot: vi.fn(async () => []),
}));

const BLOCK_QUEUE = 'yuk980_block';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${ms}ms waiting for ${what}`);
}

describe('bootWorker startup-tail shutdown coordination (YUK-980)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  const sigtermHandlers: ((signal: NodeJS.Signals) => unknown)[] = [];
  const order: string[] = [];
  const stopCalls: unknown[] = [];
  let sqlClient: ReturnType<typeof postgres> | undefined;
  // Gates + boot promise of the CURRENT test case, settled/awaited by afterEach
  // so a failing (RED) case never leaks a dangling boot into the next one.
  let activeGates: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  let activeBoot: Promise<void> | undefined;

  const warnTexts = () => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const logTexts = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  function gate<T>() {
    const g = deferred<T>();
    activeGates.push(
      g as unknown as { resolve: (v: unknown) => void; reject: (e: unknown) => void },
    );
    return g;
  }

  /** Start the real boot lifecycle and return the SIGTERM handler it installed. */
  function startBoot(options?: { startupTailWaitMs?: number }): {
    boot: Promise<void>;
    sigterm: () => Promise<void>;
  } {
    const handlerCount = sigtermHandlers.length;
    const boot = bootWorker(options);
    activeBoot = boot;
    if (sigtermHandlers.length !== handlerCount + 1) {
      throw new Error(
        `bootWorker installed ${sigtermHandlers.length - handlerCount} SIGTERM handlers, expected exactly 1`,
      );
    }
    const handler = sigtermHandlers[sigtermHandlers.length - 1];
    return {
      boot,
      sigterm: () => Promise.resolve(handler('SIGTERM') as unknown as Promise<void>),
    };
  }

  /** Mount a real consumer on the started boss whose single job blocks on a gate. */
  async function mountBlockingJob(boss: NonNullable<ReturnType<typeof getRunningBoss>>) {
    const jobStarted = gate<void>();
    const jobGate = gate<void>();
    let jobDone = false;
    await boss.createQueue(BLOCK_QUEUE);
    await boss.work(BLOCK_QUEUE, { pollingIntervalSeconds: 0.5, batchSize: 1 }, async () => {
      jobStarted.resolve(undefined);
      await jobGate.promise;
      jobDone = true;
    });
    await boss.send(BLOCK_QUEUE, { case: BLOCK_QUEUE });
    await jobStarted.promise;
    return {
      release: () => jobGate.resolve(undefined),
      isDone: () => jobDone,
    };
  }

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL required');
    sqlClient = postgres(connectionString, { max: 1 });
    // Fresh production-like cold start: no pgboss schema, no queues, no schedules.
    await sqlClient.unsafe('DROP SCHEMA IF EXISTS pgboss CASCADE');
  }, 60_000);

  afterAll(async () => {
    if (sqlClient) {
      await sqlClient.unsafe('DROP SCHEMA IF EXISTS pgboss CASCADE');
      await sqlClient.end();
    }
  });

  beforeEach(async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Intercept (not pass through): the captured handler is invoked explicitly by
    // the test, and nothing registers on the real process.signal list, so a
    // later vitest SIGTERM can never fire a stale drain handler.
    onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      cb: (signal: NodeJS.Signals) => void,
    ) => {
      if (event === 'SIGTERM') sigtermHandlers.push(cb);
      return process;
    }) as never);
    vi.mocked(registerCapabilityJobs).mockReset();
    vi.mocked(recoverToolOperationsOnBoot).mockReset();
    // Hermetic boots: leftover durable verify intents from a prior file in this
    // fork would make the real startup recovery send into verifier queues this
    // file never creates (registerCapabilityJobs is the gated mock).
    await resetDb();
    order.length = 0;
    stopCalls.length = 0;
    sigtermHandlers.length = 0;
    activeGates = [];
    activeBoot = undefined;
  });

  afterEach(async () => {
    // Settle whatever the (possibly failing) case left pending, so the boot
    // promise can finish and the boss can be stopped deterministically.
    for (const g of activeGates) g.resolve(undefined);
    if (activeBoot) await activeBoot.catch(() => undefined);
    const boss = getRunningBoss();
    if (boss) {
      await boss.stop({ graceful: false });
    }
    _resetBossForTests();
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    onSpy.mockRestore();
  }, 30_000);

  it('SIGTERM mid-registration (consumers mounted, tail pending, job in flight) drains the job and exits 0 — no false boot-window exit', async () => {
    const tailGate = gate<void>();
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      await tailGate.promise;
      order.push('cap-jobs-settled');
    });
    const { boot, sigterm } = startBoot();

    // Consumers are mounted and the tail is pending: boss is already the running
    // instance (markBossStarted precedes registerHandlers) with real consumers.
    await waitFor(
      'registerCapabilityJobs entered',
      () => vi.mocked(registerCapabilityJobs).mock.calls.length === 1,
    );
    const boss = getRunningBoss();
    if (!boss) throw new Error('getRunningBoss() must be non-null once consumers are mounted');
    const realStop = boss.stop.bind(boss);
    vi.spyOn(boss, 'stop').mockImplementation(async (...args: unknown[]) => {
      order.push('stop-called');
      stopCalls.push(args[0]);
      return realStop(args[0] as never);
    });

    const job = await mountBlockingJob(boss);

    // --- The window: in-flight job + registration tail still pending. ---
    const handled = sigterm();
    tailGate.resolve(undefined);

    // Pre-fix, this exact instant took the null-boss branch: warn "boot window
    // ... no jobs drainable" + exit(1) while the job was demonstrably in flight.
    expect(warnTexts()).not.toContain('boot window');

    await waitFor('graceful stop to begin (after the tail settled)', () =>
      order.includes('stop-called'),
    );
    // Stop strictly AFTER the registration tail settled — registrations cannot
    // race the stop (pg-boss work() on a stopped boss throws).
    expect(order).toEqual(['cap-jobs-settled', 'stop-called']);

    // Hold the job until stop is draining, then let it finish: stop(graceful)
    // must wait for it instead of cutting it off.
    job.release();
    await handled;
    await boot;

    expect(job.isDone()).toBe(true);
    const completed = await sqlClient?.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = '${BLOCK_QUEUE}' AND state = 'completed'`,
    );
    expect(completed?.[0]?.n).toBe(1);
    expect(stopCalls[0]).toEqual({ graceful: true, timeout: 30_000 });
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  }, 25_000);

  it('SIGTERM after the worker is fully ready still drains an in-flight job and exits 0', async () => {
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      order.push('cap-jobs-settled');
    });
    const { boot, sigterm } = startBoot();
    await boot; // '[worker] running, handlers registered'

    const boss = getRunningBoss();
    if (!boss) throw new Error('boss must be running after boot resolves');
    const realStop = boss.stop.bind(boss);
    vi.spyOn(boss, 'stop').mockImplementation(async (...args: unknown[]) => {
      order.push('stop-called');
      stopCalls.push(args[0]);
      return realStop(args[0] as never);
    });

    const job = await mountBlockingJob(boss);
    const handled = sigterm();
    await waitFor('graceful stop to begin', () => order.includes('stop-called'));
    job.release();
    await handled;

    expect(job.isDone()).toBe(true);
    expect(logTexts()).toContain('stopping gracefully');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  }, 25_000);

  it('SIGTERM in the pre-consumption window (boss not started, nothing drainable) exits 1 for supervised restart', async () => {
    const recoverGate = gate<void>();
    vi.mocked(recoverToolOperationsOnBoot).mockImplementation(async () => {
      await recoverGate.promise;
      return [];
    });
    const { boot, sigterm } = startBoot();
    await waitFor(
      'recoverToolOperationsOnBoot entered',
      () => vi.mocked(recoverToolOperationsOnBoot).mock.calls.length === 1,
    );
    expect(getRunningBoss()).toBeNull();

    await sigterm();
    expect(warnTexts()).toContain('boot window');
    // No boss exists — there must be no pretend-graceful stop.
    expect(logTexts()).not.toContain('stopping gracefully');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);

    // In production the process is gone here; in the test the boot continues
    // (exit is mocked) — let it finish so afterEach can stop the boss.
    recoverGate.resolve(undefined);
    await boot;
  }, 25_000);

  it('SIGTERM mid-registration while the tail then REJECTS: still stops + drains, exit owned solely by the shutdown handler', async () => {
    const tailGate = gate<void>();
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      await tailGate.promise;
    });
    const { boot, sigterm } = startBoot();
    await waitFor(
      'registerCapabilityJobs entered',
      () => vi.mocked(registerCapabilityJobs).mock.calls.length === 1,
    );
    const boss = getRunningBoss();
    if (!boss) throw new Error('boss must be running');
    const realStop = boss.stop.bind(boss);
    vi.spyOn(boss, 'stop').mockImplementation(async (...args: unknown[]) => {
      order.push('stop-called');
      return realStop(args[0] as never);
    });

    const job = await mountBlockingJob(boss);
    const handled = sigterm();
    // Boot fails while the handler is waiting for the tail — the drain must
    // continue anyway, and the boot owner must NOT race its own exit(1).
    tailGate.reject(new Error('capability registration failed'));

    await waitFor('graceful stop to begin despite the tail rejection', () =>
      order.includes('stop-called'),
    );
    job.release();
    await handled;

    expect(job.isDone()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    // The owner swallows the startup failure (shutdown owns the exit) instead of
    // rethrowing into worker.ts's exit(1) catch.
    await expect(boot).resolves.toBeUndefined();
  }, 25_000);

  it('SIGTERM mid-registration with a tail that outlives the bounded wait: stops anyway, drains, and the late tail failure is absorbed', async () => {
    const tailGate = gate<void>();
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      await tailGate.promise;
      order.push('cap-jobs-settled');
    });
    const { boot, sigterm } = startBoot({ startupTailWaitMs: 300 });
    await waitFor(
      'registerCapabilityJobs entered',
      () => vi.mocked(registerCapabilityJobs).mock.calls.length === 1,
    );
    const boss = getRunningBoss();
    if (!boss) throw new Error('boss must be running');
    const realStop = boss.stop.bind(boss);
    vi.spyOn(boss, 'stop').mockImplementation(async (...args: unknown[]) => {
      order.push('stop-called');
      return realStop(args[0] as never);
    });

    const job = await mountBlockingJob(boss);
    const handled = sigterm();
    // The tail stays pending: the wait must be BOUNDED (compose 40s grace − 30s
    // drain), never an unbounded await that guarantees a SIGKILL mid-drain.
    await waitFor('stop despite the pending tail', () => order.includes('stop-called'));
    expect(order).toEqual(['stop-called']); // tail had NOT settled when stop began
    job.release();
    await handled;

    expect(job.isDone()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(warnTexts()).toContain('did not settle within 300ms');

    // The tail resumes into a stopped boss: the next real tail step rejects, the
    // owner absorbs it (shutdown owns the exit) and boot resolves — no racing
    // exit(1), no unhandled rejection.
    tailGate.resolve(undefined);
    await boot;
    const errorTexts = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errorTexts).toContain('startup failed during shutdown');
  }, 25_000);

  it('startup failure with NO signal still rejects bootWorker (worker.ts catch exits 1 for supervised restart)', async () => {
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      throw new Error('capability registration boom');
    });
    const { boot } = startBoot();
    await expect(boot).rejects.toThrow('capability registration boom');
    expect(exitSpy).not.toHaveBeenCalled();
  }, 25_000);
});
