import { beforeEach, expect, it, vi } from 'vitest';
import { reconcileJudgeAttempts } from '@/capabilities/practice/public';
import { db } from '@/db/client';
import { registerJudgeWorkflows } from '@/server/durable/judge-worker';

const runtime = vi.hoisted(() => ({ workflowId: '', boundaryOrder: [] as string[] }));
vi.mock('@/db/client', () => ({ db: Object.freeze({}) }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() {
      return runtime.workflowId;
    },
    registerWorkflow: (body: unknown) => body,
    runStep: async (body: () => Promise<unknown>) => body(),
  },
}));
vi.mock('@/capabilities/practice/public', () => ({
  JUDGE_DBOS_QUEUE: 'judge-run-queue-v1',
  JUDGE_DBOS_WORKFLOW: 'judge-run-v1',
  buildLegacyJudgeHandler: vi.fn(),
  executeJudgeWorkflow: vi.fn(),
  reconcileJudgeAttempts: vi.fn(async () => {
    runtime.boundaryOrder.push('sweep');
  }),
}));
vi.mock('@/server/boss/queue-config', () => ({
  EXPIRE_LLM: 300,
  FAST_QUEUE_OPTS: {},
  createJobQueue: vi.fn(),
  createOrUpdateQueue: vi.fn(),
}));
vi.mock('@/server/contract-epoch', () => ({
  fenceAwareJobHandler: vi.fn(),
  waitForRunnableEpoch: vi.fn(),
}));
vi.mock('@/server/durable/judge-family', () => ({
  JUDGE_FAMILY: 'judge_run',
  JUDGE_RECONCILE_FAMILY: 'judge_pending_reconcile',
  installJudgeProducerFence: vi.fn(),
  readJudgeFamilyControl: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  runtime.boundaryOrder.length = 0;
  runtime.workflowId = '';
});

it('registered old scheduled tick passes a fresh clock capability without sampling it before the locked sweep', async () => {
  const scheduledAt = new Date('2026-10-01T23:00:00Z'),
    clock = vi.fn(() => new Date('2026-10-02T00:00:00Z'));
  runtime.workflowId = `sched-judge_pending_reconcile-${scheduledAt.toISOString()}`;
  const workflows = registerJudgeWorkflows(
    db,
    async (event) => {
      runtime.boundaryOrder.push(event.kind);
    },
    { authorizationClock: clock },
  );
  await workflows.reconcile(scheduledAt, {});
  expect(runtime.boundaryOrder).toEqual(['sweep']);
  expect(clock).not.toHaveBeenCalled();
  expect(reconcileJudgeAttempts).toHaveBeenCalledWith(db, {
    now: scheduledAt,
    tick: { backend: 'dbos', id: runtime.workflowId },
    deps: { authorizationClock: clock },
  });
});

it('default registered ticks leave authorization time to the server clock inside the sweep', async () => {
  const scheduledAt = new Date('2026-10-01T23:00:00Z');
  runtime.workflowId = `sched-judge_pending_reconcile-${scheduledAt.toISOString()}`;
  await registerJudgeWorkflows(db).reconcile(scheduledAt, {});
  expect(reconcileJudgeAttempts).toHaveBeenCalledWith(db, {
    now: scheduledAt,
    tick: { backend: 'dbos', id: runtime.workflowId },
    deps: { authorizationClock: undefined },
  });
});

it.each(['wrong-id', 'invalid-date'])(
  'rejects a malformed registered schedule identity (%s) before any sweep',
  async (kind) => {
    const scheduledAt =
      kind === 'invalid-date' ? new Date(Number.NaN) : new Date('2026-10-01T23:00:00Z');
    runtime.workflowId = 'sched-judge_pending_reconcile-wrong';
    await expect(registerJudgeWorkflows(db).reconcile(scheduledAt, {})).rejects.toThrow(
      'schedule input invalid',
    );
    expect(reconcileJudgeAttempts).not.toHaveBeenCalled();
  },
);
