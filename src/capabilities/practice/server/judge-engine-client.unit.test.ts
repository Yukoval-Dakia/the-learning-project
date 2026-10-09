import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgeReservationPayload } from '@/core/schema/event/judge-operational-events';
import {
  JUDGE_DBOS_APPLICATION,
  JUDGE_DBOS_APPLICATION_VERSION,
  JUDGE_DBOS_QUEUE,
  JUDGE_DBOS_SCHEMA,
  JUDGE_DBOS_WORKFLOW,
  enqueueDbosJudgeDelivery,
  enqueueLegacyJudgeDelivery,
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
  it('sends the complete legacy payload with the retained fixed queue and delivery ID', async () => {
    const r = reservation('pg-boss', 2),
      input = judgeDeliveryInput(r);
    const job = {
      run_id: r.run_id,
      caller: 'submit',
      submit: {
        body: {
          answer_text: 'Long answer\n'.repeat(250),
          metadata: { evidence: ['v+c=18', 'v-c=12'], unresolved: null },
        },
        question_id: 'immutable-question',
        submitted_at: '2026-10-09T00:00:00Z',
        subject_profile: { subject: 'math', nested: { version: 4 } },
      },
    } satisfies Parameters<typeof enqueueLegacyJudgeDelivery>[0];
    expect(await enqueueLegacyJudgeDelivery(job, input)).toBe(r.delivery_id);
    expect(engine.send).toHaveBeenCalledExactlyOnceWith(
      'judge_run',
      { ...job, operational: input },
      { id: r.delivery_id },
    );
    const injected = { send: vi.fn(async () => null) };
    expect(await enqueueLegacyJudgeDelivery(job, input, injected)).toBeNull();
    expect(engine.getBoss).toHaveBeenCalledTimes(1);
    expect(engine.getRunningBoss).not.toHaveBeenCalled();
    injected.send.mockRejectedValueOnce(new Error('acknowledgment unknown'));
    await expect(enqueueLegacyJudgeDelivery(job, input, injected)).rejects.toThrow(
      'acknowledgment unknown',
    );
    expect(injected.send).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared application, schema, queue and fixed workflow identity on enqueue', async () => {
    const input = judgeDeliveryInput(reservation());
    engine.workflow = workflow();
    expect(await enqueueDbosJudgeDelivery(input)).toBe(input.delivery_id);
    expect(engine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        systemDatabaseSchemaName: JUDGE_DBOS_SCHEMA,
        applicationName: 'tlp-housekeeping',
      }),
    );
    expect(engine.enqueue).toHaveBeenCalledExactlyOnceWith(
      {
        workflowID: input.delivery_id,
        workflowName: 'judge-run-v1',
        queueName: 'judge-run-v1',
        appVersion: 'prune-v1',
        applicationName: 'tlp-housekeeping',
      },
      input,
    );
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

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

  it.each([
    'PENDING',
    'ENQUEUED',
    'DELAYED',
    'SUCCESS',
    'ERROR',
    'CANCELLED',
    'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  ])('observes %s without treating it as domain truth', async (status) => {
    engine.workflow = { ...workflow(), status };
    expect(await observeJudgeDelivery(reservation())).toMatchObject({
      kind: 'present',
      state: status,
      input: judgeDeliveryInput(reservation()),
    });
    expect(engine.enqueue).not.toHaveBeenCalled();
  });

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

  it('keeps a cold mapped legacy observation unavailable without starting or looking up an engine', async () => {
    engine.running = false;
    expect(await observeJudgeDelivery(reservation('pg-boss', 2))).toEqual({
      kind: 'unavailable',
      reason: 'backend_unavailable',
    });
    expect(engine.getRunningBoss).toHaveBeenCalledTimes(1);
    expect(engine.getBoss).not.toHaveBeenCalled();
    expect(engine.getJobById).not.toHaveBeenCalled();
    expect(engine.create).not.toHaveBeenCalled();
    expect(engine.getWorkflow).not.toHaveBeenCalled();
  });

  it('keeps a cold unmapped observation unavailable without starting or querying DBOS for absence', async () => {
    engine.running = false;
    expect(await observeUnmappedJudgeRun(reservation().run_id)).toEqual({
      kind: 'unavailable',
      reason: 'backend_unavailable',
    });
    expect(engine.getRunningBoss).toHaveBeenCalledTimes(1);
    expect(engine.getBoss).not.toHaveBeenCalled();
    expect(engine.getJobById).not.toHaveBeenCalled();
    expect(engine.create).not.toHaveBeenCalled();
    expect(engine.getWorkflow).not.toHaveBeenCalled();
  });

  it('retains warm mapped authoritative absence and lookup failure without starting the client', async () => {
    const r = reservation('pg-boss', 1);
    expect(await observeJudgeDelivery(r)).toEqual({ kind: 'absent', deliveryId: r.delivery_id });
    engine.getJobById.mockRejectedValueOnce(new Error('running backend unavailable'));
    expect(await observeJudgeDelivery(r)).toEqual({
      kind: 'unavailable',
      reason: 'backend_unavailable',
    });
    expect(engine.getRunningBoss).toHaveBeenCalledTimes(2);
    expect(engine.getBoss).not.toHaveBeenCalled();
    expect(engine.create).not.toHaveBeenCalled();
  });

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

describe('actual practice and shared-host consumer wiring', () => {
  function namedBindings(path: string, kind: 'import' | 'export', from: string) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    return file.statements.flatMap((statement) => {
      if (
        kind === 'import' &&
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === from
      ) {
        const bindings = statement.importClause?.namedBindings;
        return bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => e.name.text)
          : [];
      }
      if (
        kind === 'export' &&
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === from &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      )
        return statement.exportClause.elements.map((e) => e.name.text);
      return [];
    });
  }
  it('connects dispatch, observation and reconcile to the same domain engine', () => {
    for (const [path, module, symbols] of [
      [
        'src/capabilities/practice/server/judge-run-dispatch.ts',
        './judge-engine-client',
        ['enqueueDbosJudgeDelivery', 'enqueueLegacyJudgeDelivery', 'judgeDeliveryInput'],
      ],
      [
        'src/capabilities/practice/server/judge-run-observation.ts',
        './judge-engine-client',
        ['observeJudgeDelivery', 'observeUnmappedJudgeRun'],
      ],
      [
        'src/capabilities/practice/server/judge-operational.ts',
        './judge-engine-client',
        ['judgeDeliveryInput', 'judgeLegacyJobId'],
      ],
      [
        'src/capabilities/practice/jobs/judge_pending_reconcile.ts',
        '../server/judge-engine-client',
        ['observeJudgeDelivery'],
      ],
    ] satisfies [string, string, string[]][]) {
      expect(namedBindings(path, 'import', module)).toEqual(expect.arrayContaining(symbols));
      expect(readFileSync(path, 'utf8')).not.toContain('@/server/durable/judge-client');
    }
    expect(
      namedBindings(
        'src/capabilities/practice/server/judge-run-dispatch.ts',
        'import',
        '@/server/boss/client',
      ),
    ).toEqual([]);
  });
  it('exports the real engine identities and operator census through public for the shared host', () => {
    const exported = namedBindings(
      'src/capabilities/practice/public.ts',
      'export',
      './server/judge-engine-client',
    );
    for (const [path, symbols] of [
      ['src/server/durable/judge-worker.ts', ['JUDGE_DBOS_QUEUE', 'JUDGE_DBOS_WORKFLOW']],
      [
        'src/server/durable/judge-family.ts',
        [
          'JudgeEngineInventoryT',
          'judgeLegacyJobId',
          'sealJudgeEngineInventory',
          'validateJudgeEngineInventory',
        ],
      ],
      [
        'tests/dbos-judge/cutover.db.test.ts',
        ['inspectDbosJudgeInventory', 'sealJudgeEngineInventory'],
      ],
    ] satisfies [string, string[]][]) {
      expect(namedBindings(path, 'import', '@/capabilities/practice/public')).toEqual(
        expect.arrayContaining(symbols),
      );
      expect(exported).toEqual(expect.arrayContaining(symbols));
    }
  });
});
