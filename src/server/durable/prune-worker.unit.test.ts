import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Tx } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';

const state = vi.hoisted(() => ({
  order: [] as string[],
  failPrune: false,
  reviewReconcile: vi.fn(async () => {}),
  reviewStop: vi.fn(async () => {}),
  launch: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: vi.fn((fn: unknown, options: { name: string }) => {
      state.order.push(`register:${options.name}`);
      return fn;
    }),
    setConfig: vi.fn(),
    launch: state.launch,
    shutdown: state.shutdown,
    getSchedule: vi.fn(async () => null),
    applySchedules: vi.fn(async () => {}),
    pauseSchedule: vi.fn(async () => {}),
    resumeSchedule: vi.fn(async () => {}),
  },
}));
vi.mock('@/db/client', () => ({}));
vi.mock('@/server/boss/queue-config', () => ({
  FAST_QUEUE_OPTS: {},
  EXPIRE_FAST: 60,
  EXPIRE_LLM: 300,
  EXPIRE_AGENT: 7200,
  createJobQueue: vi.fn(async () => {}),
  createOrUpdateQueue: vi.fn(async () => {}),
}));
vi.mock('@/server/contract-epoch', () => ({ waitForRunnableEpoch: vi.fn(async () => {}) }));
vi.mock('./prune-family', () => ({
  PRUNE_DBOS_SCHEMA: 'tlp_dbos',
  PRUNE_FAMILY: 'prune_job_events',
  installPruneProducerFence: vi.fn(async () => {}),
  readPrunePhase: vi.fn(async () => {
    if (state.failPrune) throw new Error('prune unavailable');
    return 'pg-boss';
  }),
  hasRecentDbosPruneReceipt: vi.fn(async () => false),
  commitPrune: vi.fn(),
  drainLegacyPrune: vi.fn(),
}));
vi.mock('./review-orphan-family', () => ({
  REVIEW_ORPHAN_FAMILY: 'prune_orphan_review_sessions',
  installReviewOrphanProducerFence: vi.fn(async () => {}),
}));
vi.mock('./review-orphan-worker', () => ({
  registerReviewOrphanWorkflow: vi.fn(() => {
    state.order.push('register:prune_orphan_review_sessions');
    return async () => {};
  }),
  createReviewOrphanBackend: vi.fn(() => ({
    reconcile: state.reviewReconcile,
    stop: state.reviewStop,
  })),
}));

function fixture() {
  // Deliberately bounded mocks. Every invoked production dependency is asserted below.
  const tx = { execute: vi.fn(async () => []) } as unknown as Tx;
  const db = {
    transaction: async (body: (tx: Tx) => Promise<unknown>) => body(tx),
  } as unknown as Db;
  const boss = {
    work: vi.fn(async () => {}),
    offWork: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    unschedule: vi.fn(async () => {}),
  } as unknown as PgBoss;
  const pruneEvents: JobDecl = {
    name: 'prune_job_events',
    backend: 'dbos',
    queue: 'fast',
    schedule: { cron: '0 4 * * *', tz: 'Asia/Shanghai' },
  };
  const reviewOrphans: JobDecl = {
    name: 'prune_orphan_review_sessions',
    backend: 'dbos',
    queue: 'fast',
    schedule: { cron: '15 4 * * *', tz: 'Asia/Shanghai' },
  };
  return { db, boss, declarations: { pruneEvents, reviewOrphans }, reconcileIntervalMs: 10 };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.order.length = 0;
  state.failPrune = false;
  state.launch.mockImplementation(async () => {
    state.order.push('launch');
  });
});
afterEach(async () => {
  const { stopDurableWorker } = await import('./prune-worker');
  await stopDurableWorker();
});

describe('one shared durable SDK lifecycle', () => {
  it('registers both workflow names before one launch and shuts down once for concurrent stops', async () => {
    const { startDurableWorker, stopDurableWorker } = await import('./prune-worker');
    const options = fixture();
    await Promise.all([startDurableWorker(options), startDurableWorker(options)]);
    expect(state.order).toEqual([
      'register:prune_job_events',
      'register:prune_orphan_review_sessions',
      'launch',
    ]);
    const { DBOS } = await import('@dbos-inc/dbos-sdk');
    expect(DBOS.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationVersion: 'prune-v1',
        executorID: 'local',
        systemDatabaseSchemaName: 'tlp_dbos',
        name: 'tlp-housekeeping',
      }),
    );
    await Promise.all([stopDurableWorker(), stopDurableWorker()]);
    expect(state.shutdown).toHaveBeenCalledTimes(1);
    expect(state.reviewStop).toHaveBeenCalledTimes(1);
  });
  it('preserves the prune-only compatibility result and rejects later expansion/different DB/boss/contracts', async () => {
    const { startPruneWorker, startDurableWorker } = await import('./prune-worker');
    const options = fixture();
    const prune = { ...options, decl: options.declarations.pruneEvents };
    const [a, b] = await Promise.all([startPruneWorker(prune), startPruneWorker(prune)]);
    expect(a).toBe(b);
    await expect(startDurableWorker(options)).rejects.toThrow('cannot change');
    await expect(startPruneWorker({ ...prune, db: fixture().db })).rejects.toThrow('cannot change');
    await expect(startPruneWorker({ ...prune, boss: fixture().boss })).rejects.toThrow(
      'cannot change',
    );
    await expect(
      startPruneWorker({
        ...prune,
        decl: { ...prune.decl, schedule: { cron: '* * * * *', tz: 'UTC' } },
      }),
    ).rejects.toThrow('cannot change');
    expect(state.launch).toHaveBeenCalledTimes(1);
  });
  it('does not starve review reconciliation when prune fails, including startup failure cleanup', async () => {
    const { startDurableWorker } = await import('./prune-worker');
    state.failPrune = true;
    await expect(startDurableWorker(fixture())).rejects.toThrow('reconciliation failed');
    expect(state.reviewReconcile).toHaveBeenCalledTimes(1);
    expect(state.shutdown).toHaveBeenCalledTimes(1);
  });
  it('settles pending reconciliation before SDK shutdown', async () => {
    const { startDurableWorker, stopDurableWorker } = await import('./prune-worker');
    await startDurableWorker(fixture());
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.reviewReconcile.mockImplementationOnce(async () => held);
    await vi.waitFor(() => expect(state.reviewReconcile).toHaveBeenCalledTimes(2));
    const stop = stopDurableWorker();
    await Promise.resolve();
    expect(state.shutdown).not.toHaveBeenCalled();
    release();
    await stop;
    expect(state.shutdown).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed declarations before launch', async () => {
    const { startDurableWorker } = await import('./prune-worker');
    const options = fixture();
    await expect(
      startDurableWorker({
        ...options,
        declarations: {
          ...options.declarations,
          reviewOrphans: { ...options.declarations.reviewOrphans, queue: 'llm' },
        },
      }),
    ).rejects.toThrow('Invalid');
    expect(state.launch).not.toHaveBeenCalled();
  });
});

describe('collected production admission', () => {
  it('rejects unknown, duplicate and incomplete sets before launching anything', async () => {
    const { registerCapabilityJobs } = await import('@/server/boss/register-capability-jobs');
    const options = fixture();
    for (const declarations of [
      [options.declarations.pruneEvents],
      [
        options.declarations.pruneEvents,
        options.declarations.pruneEvents,
        options.declarations.reviewOrphans,
      ],
      [
        { ...options.declarations.pruneEvents, name: 'unowned-family' },
        options.declarations.reviewOrphans,
      ],
    ]) {
      const capability = {
        name: 'observability',
        description: 'test admission',
        jobs: { handlers: declarations },
      };
      await expect(
        registerCapabilityJobs(options.boss, options.db, [capability]),
      ).rejects.toThrow();
    }
    expect(state.launch).not.toHaveBeenCalled();
    expect(options.boss.work).not.toHaveBeenCalled();
  });
  it('passes both manifest declarations through one host launch', async () => {
    const { registerCapabilityJobs } = await import('@/server/boss/register-capability-jobs');
    const options = fixture();
    await registerCapabilityJobs(options.boss, options.db, [
      {
        name: 'observability',
        description: 'test admission',
        jobs: { handlers: [options.declarations.reviewOrphans, options.declarations.pruneEvents] },
      },
    ]);
    expect(state.order).toEqual([
      'register:prune_job_events',
      'register:prune_orphan_review_sessions',
      'launch',
    ]);
  });
});
