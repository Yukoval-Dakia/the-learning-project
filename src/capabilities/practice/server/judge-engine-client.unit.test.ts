import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgeReservationPayload } from '@/core/schema/event/judge-operational-events';
import {
  JUDGE_DBOS_APPLICATION,
  JUDGE_DBOS_APPLICATION_VERSION,
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_WORKFLOW,
  enqueueDbosJudgeDelivery,
  inspectDbosJudgeInventory,
  judgeDeliveryInput,
  judgeLegacyJobId,
  observeJudgeDelivery,
  observeUnmappedJudgeRun,
  sealJudgeEngineInventory,
  validateJudgeEngineInventory,
} from './judge-engine-client';

const engine = vi.hoisted(() => {
  const workflow: unknown = null;
  const job: unknown = null;
  return {
    workflow,
    job,
    getWorkflow: vi.fn(async (_id: string): Promise<unknown> => engine.workflow),
    getJobById: vi.fn(async (_queue: string, _id: string): Promise<unknown> => engine.job),
    enqueue: vi.fn(async (_options: unknown, input: { delivery_id: string }) => ({
      workflowID: input.delivery_id,
    })),
    send: vi.fn(
      async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? null,
    ),
    listWorkflows: vi.fn(async (_options: unknown): Promise<unknown[]> => []),
    listSchedules: vi.fn(async (_options: unknown): Promise<unknown[]> => []),
    destroy: vi.fn(async () => {}),
    create: vi.fn(async (_options: unknown) => engine),
    getBoss: vi.fn(async () => engine),
    running: true,
    getRunningBoss: vi.fn(() => (engine.running ? engine : null)),
  };
});
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOSClient: { create: engine.create } }));
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: engine.getBoss,
  getRunningBoss: engine.getRunningBoss,
}));
vi.mock('./judge-durable-config', () => ({ JUDGE_RUN_QUEUE: 'judge_run' }));

function reservation(backend: 'dbos' | 'pg-boss' = 'dbos', slot = 0) {
  const runId = 'judge_native_immutable-submission';
  return JudgeReservationPayload.parse({
    coordinate: 'native',
    version: 1,
    run_id: runId,
    pending_id: `evt_pending_${runId}`,
    pending_digest: canonicalHash({
      answer: '长作答与歧义\n'.repeat(250),
      units: [{ relation: 'v+c=18', evidence: ['v-c=12', null] }],
    }),
    slot,
    delivery_id:
      backend === 'dbos' ? `judge-run-v1:${runId}:delivery:${slot}` : judgeLegacyJobId(runId, slot),
    ownership: { incarnation: 'b5ae67a2-9976-4abd-a537-dbcfbbf3a8f8', epoch: 3, backend },
    reserved_at: '2026-10-09T00:00:00Z',
  });
}
function workflow(r = reservation()) {
  return {
    workflowID: r.delivery_id,
    workflowName: JUDGE_DBOS_WORKFLOW,
    queueName: JUDGE_DBOS_QUEUE,
    applicationName: JUDGE_DBOS_APPLICATION,
    applicationVersion: JUDGE_DBOS_APPLICATION_VERSION,
    status: 'PENDING',
    input: [judgeDeliveryInput(r)],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgres://unused-unit-only/db');
  engine.workflow = null;
  engine.job = null;
  engine.running = true;
  engine.getWorkflow.mockImplementation(async () => engine.workflow);
  engine.getJobById.mockImplementation(async () => engine.job);
  engine.listWorkflows.mockResolvedValue([]);
  engine.listSchedules.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe('practice judge engine delivery contract', () => {
  // @invariant concurrency: a delivery whose workflow identity, pending digest or ownership incarnation/epoch mismatches the reservation stays identity_unverified and can never be acknowledged on enqueue
  // @fails-if accept the observed workflow on partial identity (e.g. id and state only) or acknowledge the enqueue; the unavailable result, enqueue rejection and destroy-count assertions fail
  it.each([
    ['name', { workflowName: 'other' }],
    ['queue', { queueName: 'other' }],
    ['application', { applicationName: 'other' }],
    ['version', { applicationVersion: 'other' }],
    [
      'digest',
      { input: [{ ...judgeDeliveryInput(reservation()), pending_digest: 'f'.repeat(64) }] },
    ],
    [
      'incarnation',
      {
        input: [
          {
            ...judgeDeliveryInput(reservation()),
            ownership: {
              ...reservation().ownership,
              incarnation: '688ab400-0386-4bc9-97a7-0d3a1223a816',
            },
          },
        ],
      },
    ],
    [
      'epoch',
      {
        input: [
          {
            ...judgeDeliveryInput(reservation()),
            ownership: { ...reservation().ownership, epoch: 4 },
          },
        ],
      },
    ],
    ['delivery', { input: [{ ...judgeDeliveryInput(reservation()), delivery_id: 'wrong' }] }],
    ['missing input', { input: [] }],
  ])('keeps %s mismatch unknown and refuses an enqueue acknowledgment', async (_label, change) => {
    engine.workflow = { ...workflow(), ...change };
    expect(await observeJudgeDelivery(reservation())).toEqual({
      kind: 'unavailable',
      reason: 'identity_unverified',
    });
    await expect(enqueueDbosJudgeDelivery(judgeDeliveryInput(reservation()))).rejects.toThrow();
    expect(engine.destroy).toHaveBeenCalledTimes(2);
  });

  // @invariant data: absence is reported only when the engine lookup authoritatively verifies it; unsupported states and lookup failures stay unavailable, never absent
  // @fails-if map an unsupported status or a thrown lookup to absent; the identity_unverified/backend_unavailable assertions fail and reconcile would authorize a duplicate send
  it('distinguishes authoritative absence, invalid state and lookup failure', async () => {
    expect(await observeJudgeDelivery(reservation())).toEqual({
      kind: 'absent',
      deliveryId: reservation().delivery_id,
    });
    engine.workflow = { ...workflow(), status: 'UNSUPPORTED' };
    expect(await observeJudgeDelivery(reservation())).toEqual({
      kind: 'unavailable',
      reason: 'identity_unverified',
    });
    engine.getWorkflow.mockRejectedValueOnce(new Error('timeout'));
    expect(await observeJudgeDelivery(reservation())).toEqual({
      kind: 'unavailable',
      reason: 'backend_unavailable',
    });
    expect(engine.destroy).toHaveBeenCalledTimes(3);
  });

  // @invariant concurrency: a legacy pg-boss delivery is only 'present' when the full operational input — including the pending digest — matches the reservation, with the legacy state mapping preserved
  // @fails-if compare job id and state without the full operational input so a foreign job or wrong digest reads as present; the identity_unverified and per-state mapping assertions fail
  it.each([
    ['active', 'PENDING'],
    ['completed', 'SUCCESS'],
    ['failed', 'ERROR'],
    ['cancelled', 'CANCELLED'],
    ['created', 'ENQUEUED'],
    ['retry', 'ENQUEUED'],
  ])(
    'preserves legacy %s mapping and compares the full operational input',
    async (state, expected) => {
      const r = reservation('pg-boss');
      engine.job = {
        id: r.delivery_id,
        state,
        data: {
          run_id: r.run_id,
          operational: judgeDeliveryInput(r),
          submitted: { nested: ['long\n'.repeat(160)] },
        },
      };
      expect(await observeJudgeDelivery(r)).toMatchObject({
        kind: 'present',
        state: expected,
        input: judgeDeliveryInput(r),
        deliveryId: r.delivery_id,
      });
      expect(engine.getJobById).toHaveBeenCalledWith('judge_run', r.delivery_id);
      engine.job = {
        id: r.delivery_id,
        state,
        data: { operational: { ...judgeDeliveryInput(r), pending_digest: '0'.repeat(64) } },
      };
      expect(await observeJudgeDelivery(r)).toEqual({
        kind: 'unavailable',
        reason: 'identity_unverified',
      });
    },
  );

  // @invariant data: an unmapped-run observation reports absent only after querying all three deterministic ids in both engines — a run may still live in a slot not yet checked
  // @fails-if short-circuit after the first slot or query only one engine; the exact 3-job/3-workflow call-shape assertions fail and a live run could read as absent
  it('queries all three deterministic IDs in both engines before an unmapped absence', async () => {
    const runId = reservation().run_id;
    expect(await observeUnmappedJudgeRun(runId)).toEqual({
      kind: 'absent',
      deliveryId: reservation().delivery_id,
    });
    expect(engine.getJobById.mock.calls).toEqual(
      [0, 1, 2].map((slot) => ['judge_run', judgeLegacyJobId(runId, slot)]),
    );
    expect(engine.getWorkflow.mock.calls).toEqual(
      [0, 1, 2].map((slot) => [`judge-run-v1:${runId}:delivery:${slot}`]),
    );
    expect(engine.getRunningBoss).toHaveBeenCalledTimes(1);
    expect(engine.getBoss).not.toHaveBeenCalled();
    engine.job = { data: { corrupt: true } };
    expect(await observeUnmappedJudgeRun(runId)).toEqual({
      kind: 'unavailable',
      reason: 'identity_unverified',
    });
    engine.job = null;
    engine.getWorkflow.mockRejectedValueOnce(new Error('engine unavailable'));
    expect(await observeUnmappedJudgeRun(runId)).toEqual({
      kind: 'unavailable',
      reason: 'backend_unavailable',
    });
  });

  // @invariant data: the engine inventory census enumerates every delivery page plus the reconcile tick and schedule, and its digest seal rejects any tampered or duplicated inventory
  // @fails-if skip a page or the tick/schedule, or accept an inventory with a wrong digest/duplicate item/foreign fixed id; the 202-item, offset-shape, kind and seal-conflict/input-mismatch assertions fail
  it('censuses every page, reconcile tick and schedule, then validates its seal', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => {
      const r = reservation();
      const deliveryId = `judge-run-v1:run-${i}:delivery:0`;
      return {
        ...workflow(r),
        workflowID: deliveryId,
        input: [{ ...judgeDeliveryInput(r), run_id: `run-${i}`, delivery_id: deliveryId }],
      };
    });
    const tick = {
      ...workflow(),
      workflowID: 'reconcile-tick',
      workflowName: 'judge-pending-reconcile-v1',
      input: [{ frozen: { ids: ['x', 'y'], cursor: null } }],
    };
    const schedule = {
      scheduleId: 'reconcile-schedule',
      status: 'ACTIVE',
      workflowName: 'judge-pending-reconcile-v1',
      cron: '* * * * *',
    };
    engine.listWorkflows.mockResolvedValueOnce(rows).mockResolvedValueOnce([tick]);
    engine.listSchedules.mockResolvedValueOnce([schedule]);
    const inventory = await inspectDbosJudgeInventory();
    expect(inventory.items).toHaveLength(202);
    expect(engine.listWorkflows.mock.calls.map(([options]) => options)).toEqual(
      [0, 200].map((offset) =>
        expect.objectContaining({
          offset,
          limit: 200,
          loadInput: true,
          workflowName: ['judge-run-v1', 'judge-pending-reconcile-v1'],
        }),
      ),
    );
    expect(inventory.items).toContainEqual(
      expect.objectContaining({ task_id: tick.workflowID, kind: 'tick', run_id: null }),
    );
    expect(inventory.items).toContainEqual(
      expect.objectContaining({ task_id: schedule.scheduleId, kind: 'schedule', run_id: null }),
    );
    expect(validateJudgeEngineInventory(inventory)).toEqual(inventory);
    expect(() => validateJudgeEngineInventory({ ...inventory, digest: '0'.repeat(64) })).toThrow(
      'seal conflict',
    );
    const first = inventory.items[0];
    if (!first) throw new Error('Missing fixture inventory');
    const duplicate = sealJudgeEngineInventory('dbos', [first, first]);
    expect(() => validateJudgeEngineInventory(duplicate)).toThrow('seal conflict');
    engine.listWorkflows.mockResolvedValueOnce([{ ...workflow(), workflowID: 'wrong-fixed-id' }]);
    await expect(inspectDbosJudgeInventory()).rejects.toThrow('input mismatch');
  });
});
