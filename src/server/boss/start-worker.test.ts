// YUK-384 — the worker boss-start path must record the started boss as running so
// getRunningBoss() returns it IN THE WORKER. Without it the FULL hub-sync mutation-wake
// + continuation dispatch (which peek getRunningBoss to send best-effort) are inert
// exactly where they run. Pure no-DB unit: pg-boss + every startBossWorker dependency
// is vi.mock'd, so no live Postgres is touched. The real @/server/boss/client is used
// (with pg-boss mocked) so markBossStarted/getRunningBoss exercise the real bossState.
// src/server/boss/** has no unit glob (client.globalthis.test.ts precedent), so this is
// explicitly listed in vitest.shared.ts fastTestInclude.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockPgBoss {
  start = vi.fn(async () => undefined);
  on = vi.fn();
  once = vi.fn();
  work = vi.fn(async () => undefined);
  send = vi.fn(async () => undefined);
}

vi.mock('pg-boss', () => ({ PgBoss: MockPgBoss, default: MockPgBoss }));
vi.mock('@/capabilities', () => ({ capabilities: [] }));
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
});
