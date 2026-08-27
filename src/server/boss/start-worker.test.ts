// YUK-384 — the worker boss-start path must record the started boss as running so
// getRunningBoss() returns it IN THE WORKER. Without it the FULL hub-sync mutation-wake
// + continuation dispatch (which peek getRunningBoss to send best-effort) are inert
// exactly where they run. Pure no-DB unit: pg-boss + every startBossWorker dependency
// is vi.mock'd, so no live Postgres is touched. The real @/server/boss/client is used
// (with pg-boss mocked) so markBossStarted/getRunningBoss exercise the real bossState.
// src/server/boss/** has no unit glob (client.globalthis.test.ts precedent), so this is
// explicitly listed in vitest.shared.ts fastTestInclude.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let onBossStart: (() => void) | undefined;

class MockPgBoss {
  start = vi.fn(async () => onBossStart?.());
  on = vi.fn();
  once = vi.fn();
  work = vi.fn(async () => undefined);

  // Prototype method (not a class field) so tests can vi.spyOn the prototype
  // and intercept sends made against instances created inside startBossWorker.
  send(..._args: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

vi.mock('pg-boss', () => ({ PgBoss: MockPgBoss, default: MockPgBoss }));
vi.mock('@/capabilities', () => ({ capabilities: [] }));
vi.mock('@/kernel/tools/tool-operations', () => ({
  recoverToolOperationsOnBoot: vi.fn(async () => []),
}));
vi.mock('@/server/boss/handlers', () => ({ registerHandlers: vi.fn(async () => undefined) }));
vi.mock('@/server/boss/handlers/ai_task_run_reconcile', () => ({
  reconcileStuckAiTaskRuns: vi.fn(async () => undefined),
}));
vi.mock('@/server/boss/register-capability-jobs', () => ({
  registerCapabilityJobs: vi.fn(async () => undefined),
}));
vi.mock('@/server/subjects/hydrate', () => ({
  hydrateSubjectRegistryFromDb: vi.fn(async () => undefined),
  startSubjectRefresh: vi.fn(() => ({ stop: vi.fn() })),
}));

describe('startBossWorker marks the running boss (YUK-384 wake activation)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/loom_test');
  });

  afterEach(() => {
    onBossStart = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('records the started boss so getRunningBoss() returns it in the worker process', async () => {
    const { startBossWorker } = await import('./start-worker');
    const { getRunningBoss, _resetBossForTests } = await import('./client');
    _resetBossForTests();
    expect(getRunningBoss()).toBeNull();

    const boss = await startBossWorker({} as never);

    // Pre-fix: startBossWorker never recorded the running boss → getRunningBoss() stayed
    // null in the worker → the mutation-wake/continuation peek always no-op'd.
    expect(getRunningBoss()).toBe(boss);
    expect(getRunningBoss()).not.toBeNull();
  });

  it('runs ToolOperations recovery before pg-boss starts accepting work', async () => {
    const order: string[] = [];
    const { recoverToolOperationsOnBoot } = await import('@/kernel/tools/tool-operations');
    vi.mocked(recoverToolOperationsOnBoot).mockClear();
    vi.mocked(recoverToolOperationsOnBoot).mockImplementation(async () => {
      order.push('tool-operations-recovered');
      return [];
    });
    onBossStart = () => {
      order.push('boss-started');
    };
    const { startBossWorker } = await import('./start-worker');
    const { _resetBossForTests } = await import('./client');
    _resetBossForTests();

    await startBossWorker({} as never);

    expect(order).toEqual(['tool-operations-recovered', 'boss-started']);
    expect(recoverToolOperationsOnBoot).toHaveBeenCalledTimes(1);
  });

  it('X4: after markBossStarted, getStartedBoss() returns the running boss WITHOUT a second start()', async () => {
    const { startBossWorker } = await import('./start-worker');
    const { getStartedBoss, _resetBossForTests } = await import('./client');
    _resetBossForTests();

    const boss = (await startBossWorker({} as never)) as unknown as MockPgBoss;
    expect(boss.start).toHaveBeenCalledTimes(1); // startBossWorker started it once

    // A same-process route enqueue (RW_WORKER=1) goes through getStartedBoss. Pre-fix it saw
    // startPromise=null (markBossStarted only set `started`) → created a fresh boss + called
    // start() again on the already-running instance.
    const viaGetter = await getStartedBoss();
    expect(viaGetter).toBe(boss);
    expect(boss.start).toHaveBeenCalledTimes(1); // NOT re-started
  });

  // YUK-891 — the verify-dispatch startup trigger must fire only AFTER capability
  // registration created the quiz_verify/source_verify queues. Pre-fix the send
  // lived at the end of registerHandlers (which runs first), so the already-polling
  // verify_dispatch_recover worker could execute the recovery before those queues
  // existed and the first boss.send into them threw pg-boss's missing-queue error.
  it('YUK-891: fires verify-dispatch startup recovery only after registerCapabilityJobs resolves', async () => {
    const order: string[] = [];
    const { registerCapabilityJobs } = await import('@/server/boss/register-capability-jobs');
    vi.mocked(registerCapabilityJobs).mockImplementation(async () => {
      // Resolve asynchronously so the test can prove the trigger is not merely
      // initiated after registration STARTS, but strictly after it resolves.
      await Promise.resolve();
      order.push('capability-jobs-resolved');
    });
    const sendSpy = vi.spyOn(MockPgBoss.prototype, 'send').mockImplementation(async () => {
      order.push('startup-recovery-send');
      return undefined;
    });

    const { startBossWorker } = await import('./start-worker');
    const { _resetBossForTests } = await import('./client');
    _resetBossForTests();
    await startBossWorker({} as never);

    expect(order.indexOf('capability-jobs-resolved')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('capability-jobs-resolved')).toBeLessThan(
      order.indexOf('startup-recovery-send'),
    );
    // Every completed boot sends one trigger. There is no inert send-level dedup option;
    // duplicate boots are safe because the recovery handler drains durable intents idempotently.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('verify_dispatch_recover', { trigger: 'startup' });

    sendSpy.mockRestore();
  });
});
