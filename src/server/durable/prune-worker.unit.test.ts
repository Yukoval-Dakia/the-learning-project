import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Tx } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';

const state = vi.hoisted(() => ({
  order: [] as string[],
  judgeReconcile: vi.fn(async () => {}),
  judgeStop: vi.fn(async () => {}),
  failPrune: false,
  workflowId: '',
  reviewReconcile: vi.fn(async () => {}),
  reviewStop: vi.fn(async () => {}),
  conversationReconcile: vi.fn(async () => {}),
  placementReconcile: vi.fn(async () => {}),
  conversationStop: vi.fn(async () => {}),
  placementStop: vi.fn(async () => {}),
  launch: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() {
      return state.workflowId;
    },
    runStep: vi.fn(async (body: () => Promise<unknown>) => body()),
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

vi.mock('./session-orphan-backend', async (actual) => ({
  ...(await actual<typeof import('./session-orphan-backend')>()),
  installSessionOrphanProducerFence: vi.fn(async () => {}),
}));
vi.mock('./session-orphan-worker', () => ({
  registerSessionOrphanWorkflows: vi.fn(() => {
    state.order.push(
      'register:prune_orphan_conversation_sessions',
      'register:prune_orphan_placement_sessions',
    );
    return { conversationOrphans: async () => {}, placementOrphans: async () => {} };
  }),
  createSessionOrphanBackend: vi.fn(({ binding }: { binding: { family: string } }) =>
    binding.family === 'prune_orphan_conversation_sessions'
      ? { reconcile: state.conversationReconcile, stop: state.conversationStop }
      : { reconcile: state.placementReconcile, stop: state.placementStop },
  ),
}));

vi.mock('./judge-worker', () => ({
  prepareJudgeBackend: vi.fn(async () => {}),
  registerJudgeWorkflows: vi.fn(() => {
    state.order.push('register:judge-run-v1', 'register:judge-pending-reconcile-v1');
    return { execute: async () => {}, reconcile: async () => {} };
  }),
  createJudgeBackend: vi.fn(() => ({ reconcile: state.judgeReconcile, stop: state.judgeStop })),
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
  const conversationOrphans: JobDecl = {
    name: 'prune_orphan_conversation_sessions',
    backend: 'dbos',
    queue: 'fast',
    schedule: { cron: '25 4 * * *', tz: 'Asia/Shanghai' },
  };
  const placementOrphans: JobDecl = {
    name: 'prune_orphan_placement_sessions',
    backend: 'dbos',
    queue: 'fast',
    schedule: { cron: '35 4 * * *', tz: 'Asia/Shanghai' },
  };
  return {
    db,
    boss,
    declarations: { pruneEvents, reviewOrphans, conversationOrphans, placementOrphans },
    reconcileIntervalMs: 10,
  };
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
  it('registers four workflow names before one launch and shuts down once for concurrent stops', async () => {
    const { startDurableWorker, stopDurableWorker } = await import('./prune-worker');
    const options = fixture();
    await Promise.all([startDurableWorker(options), startDurableWorker(options)]);
    expect(state.order).toEqual([
      'register:prune_job_events',
      'register:prune_orphan_review_sessions',
      'register:prune_orphan_conversation_sessions',
      'register:prune_orphan_placement_sessions',
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
    expect(state.conversationReconcile).toHaveBeenCalledTimes(1);
    expect(state.placementReconcile).toHaveBeenCalledTimes(1);
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
  it('registers the paired judge workflows before the same launch and stops through the existing lifecycle', async () => {
    const { startDurableWorker, stopDurableWorker } = await import('./prune-worker');
    const options = fixture();
    const judgeRun: JobDecl = { name: 'judge_run', backend: 'dbos', queue: 'llm' };
    const judgeReconcile: JobDecl = {
      name: 'judge_pending_reconcile',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '50 * * * *', tz: 'Asia/Shanghai' },
    };
    await startDurableWorker({
      ...options,
      declarations: { ...options.declarations, judgeRun, judgeReconcile },
    });
    expect(state.order).toEqual([
      'register:prune_job_events',
      'register:judge-run-v1',
      'register:judge-pending-reconcile-v1',
      'register:prune_orphan_review_sessions',
      'register:prune_orphan_conversation_sessions',
      'register:prune_orphan_placement_sessions',
      'launch',
    ]);
    expect(state.launch).toHaveBeenCalledTimes(1);
    expect(state.judgeReconcile).toHaveBeenCalledTimes(1);
    await stopDurableWorker();
    expect(state.judgeStop).toHaveBeenCalledTimes(1);
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
  it('passes all four manifest declarations through one host launch', async () => {
    const { registerCapabilityJobs } = await import('@/server/boss/register-capability-jobs');
    const options = fixture();
    await registerCapabilityJobs(options.boss, options.db, [
      {
        name: 'observability',
        description: 'test admission',
        jobs: { handlers: Object.values(options.declarations).reverse() },
      },
    ]);
    expect(state.order).toEqual([
      'register:prune_job_events',
      'register:prune_orphan_review_sessions',
      'register:prune_orphan_conversation_sessions',
      'register:prune_orphan_placement_sessions',
      'launch',
    ]);
  });
});

describe('session orphan boundaries and operator contract', () => {
  it('rejects malformed and cross-family scheduled identities without touching a DB', async () => {
    const { sessionOrphanRequestSchema } = await import('./session-orphan-family');
    const family = 'prune_orphan_conversation_sessions';
    const scheduledAt = new Date('2026-10-09T00:00:00Z');
    const request = {
      family,
      source: {
        kind: 'dbos',
        scheduledAt,
        workflowId: `sched-${family}-${scheduledAt.toISOString()}`,
      },
    };
    expect(sessionOrphanRequestSchema.parse(request)).toEqual(request);
    for (const workflowId of [
      'manual',
      `sched-prune_orphan_placement_sessions-${scheduledAt.toISOString()}`,
      `sched-${family}-2026-10-09T00:00:01.000Z`,
    ])
      expect(
        sessionOrphanRequestSchema.safeParse({
          ...request,
          source: { ...request.source, workflowId },
        }).success,
      ).toBe(false);
    expect(
      sessionOrphanRequestSchema.safeParse({ family, source: { kind: 'pg-boss', jobId: 'fake' } })
        .success,
    ).toBe(false);
    expect(sessionOrphanRequestSchema.safeParse({ ...request, bypass: true }).success).toBe(false);
    expect(
      sessionOrphanRequestSchema.safeParse({
        ...request,
        source: { ...request.source, scheduledAt: new Date(NaN) },
      }).success,
    ).toBe(false);
  });
  it('parses immutable outcomes and refuses review reopening, corrupt versions or optional bags', async () => {
    const { sessionOrphanOutcomeSchema } = await import('./session-orphan-family');
    expect(
      sessionOrphanOutcomeSchema.parse({ kind: 'abandoned', fromVersion: 19, toVersion: 20 }),
    ).toEqual({ kind: 'abandoned', fromVersion: 19, toVersion: 20 });
    for (const value of [
      { kind: 'skipped', reason: 'reopened' },
      { kind: 'abandoned', fromVersion: 19, toVersion: 19 },
      { kind: 'deferred-known-failure', error: '' },
      { kind: 'skipped', reason: 'terminal', success: true },
    ])
      expect(sessionOrphanOutcomeSchema.safeParse(value).success).toBe(false);
  });
  it('requires an explicit exact family and concrete inspection/disposition targets', async () => {
    const { parseSessionOrphanCommand } = await import('./session-orphan-backend');
    const family = 'prune_orphan_placement_sessions';
    expect(parseSessionOrphanCommand(['--family', family, 'inspect', 'tick', 'session'])).toEqual({
      family,
      action: 'inspect',
      tickId: 'tick',
      sessionId: 'session',
    });
    expect(
      parseSessionOrphanCommand([
        '--family',
        family,
        'retire',
        'dbos',
        'task',
        'observed exit',
        'tick',
        'session',
      ]),
    ).toMatchObject({
      disposition: {
        kind: 'terminal-row',
        family,
        taskId: 'task',
        tickId: 'tick',
        sessionId: 'session',
      },
    });
    for (const args of [
      ['status'],
      ['--family', 'all', 'status'],
      ['--family', family, 'replay'],
      ['--family', family, 'inspect', 'tick'],
      ['--family', family, 'status', 'extra'],
      ['--family', family, 'retire', 'dbos', 'task', 'reason', 'session'],
    ])
      expect(() => parseSessionOrphanCommand(args)).toThrow();
  });
  it('attempts every adapter stop and one shutdown even when two adapters throw', async () => {
    const { startDurableWorker, stopDurableWorker } = await import('./prune-worker');
    await startDurableWorker(fixture());
    state.reviewStop.mockRejectedValueOnce(new Error('review stop'));
    state.conversationStop.mockRejectedValueOnce(new Error('conversation stop'));
    await expect(stopDurableWorker()).rejects.toThrow('shutdown failed');
    expect(state.placementStop).toHaveBeenCalledTimes(1);
    expect(state.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('exact session workflow step contracts', () => {
  it('registers concrete names, scheduled arguments and immutable retry-disabled steps', async () => {
    const familyModule = await import('./session-orphan-family');
    const run = vi
      .spyOn(familyModule, 'runSessionOrphanTick')
      .mockImplementation(async (_db, request) => ({
        family: request.family,
        tickId:
          request.source.kind === 'dbos'
            ? request.source.workflowId
            : `legacy:${request.source.jobId}`,
        kind: 'fenced',
        candidates: 0,
        abandoned: 0,
        skipped: 0,
        deferred: 0,
      }));
    const actual =
      await vi.importActual<typeof import('./session-orphan-worker')>('./session-orphan-worker');
    const boundary = vi.fn(async () => {}),
      options = fixture();
    const workflows = actual.registerSessionOrphanWorkflows(options.db, boundary);
    const scheduledAt = new Date('2026-10-09T00:00:00Z');
    const { DBOS } = await import('@dbos-inc/dbos-sdk');
    for (const [family, workflow, step] of [
      [
        'prune_orphan_conversation_sessions',
        workflows.conversationOrphans,
        'conversation-orphan-sweep-v1',
      ],
      ['prune_orphan_placement_sessions', workflows.placementOrphans, 'placement-orphan-sweep-v1'],
    ] as const) {
      state.workflowId = `sched-${family}-${scheduledAt.toISOString()}`;
      await workflow(scheduledAt, {});
      expect(run).toHaveBeenLastCalledWith(
        options.db,
        { family, source: { kind: 'dbos', workflowId: state.workflowId, scheduledAt } },
        boundary,
      );
      expect(DBOS.runStep).toHaveBeenLastCalledWith(expect.any(Function), {
        name: step,
        retriesAllowed: false,
      });
      expect(boundary).toHaveBeenLastCalledWith({
        family,
        tickId: state.workflowId,
        kind: 'checkpoint-saved',
      });
    }
    run.mockRestore();
  });
  it('rejects unsupported saved contract versions and unsorted/duplicate candidate evidence', async () => {
    const { sessionOrphanTickSchema } = await import('./session-orphan-family');
    const family = 'prune_orphan_conversation_sessions';
    const tick = {
      family,
      tick_id: `sched-${family}-2026-10-09T00:00:00.000Z`,
      backend: 'dbos',
      provenance: 'scheduled',
      tick_at: '2026-10-09 00:00:00+00',
      cutoff: '2026-10-08 18:00:00+00',
      admission: 'admitted',
      candidates: [],
      contract_version: 1,
    };
    expect(sessionOrphanTickSchema.safeParse(tick).success).toBe(true);
    expect(sessionOrphanTickSchema.safeParse({ ...tick, contract_version: 2 }).success).toBe(false);
    const candidate = {
      sessionId: 'b',
      selectedStartedAt: '2026-10-08 12:00:00.123456+00',
      selectedVersion: 12,
    };
    for (const candidates of [
      [candidate, candidate],
      [candidate, { ...candidate, sessionId: 'a' }],
      [{ ...candidate, selectedVersion: -1 }],
    ])
      expect(sessionOrphanTickSchema.safeParse({ ...tick, candidates }).success).toBe(false);
  });
  it('rejects load/singletons/missing schedule and wrong tiers before mounting any declaration', async () => {
    const { registerCapabilityJobs } = await import('@/server/boss/register-capability-jobs');
    const options = fixture();
    for (const replacement of [
      { ...options.declarations.placementOrphans, queue: 'llm' },
      { ...options.declarations.placementOrphans, schedule: undefined },
      { ...options.declarations.placementOrphans, schedule: { cron: ' ', tz: 'UTC' } },
      { ...options.declarations.placementOrphans, schedule: { cron: '* * * * *', tz: ' ' } },
      {
        ...options.declarations.placementOrphans,
        schedule: { cron: '* * * * *', tz: 'UTC', singletonKey: 'test', singletonSeconds: 60 },
      },
      { ...options.declarations.placementOrphans, load: async () => () => async () => {} },
    ] satisfies JobDecl[]) {
      await expect(
        registerCapabilityJobs(options.boss, options.db, [
          {
            name: 'observability',
            description: 'test',
            jobs: {
              handlers: [
                options.declarations.pruneEvents,
                options.declarations.reviewOrphans,
                options.declarations.conversationOrphans,
                replacement,
              ],
            },
          },
        ]),
      ).rejects.toThrow('Invalid');
    }
    expect(state.launch).not.toHaveBeenCalled();
    expect(options.boss.work).not.toHaveBeenCalled();
  });
});
