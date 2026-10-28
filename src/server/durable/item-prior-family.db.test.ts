// Offline checks of the blocked candidate, not DBOS crash/recovery acceptance.
// Dispatched admission now requires the node-bound stored pg-boss payload.
// These cached-step checks validate replay identity only; prepared DB cases cover live ownership.
// Dispatch checks use the actual adapter/store with a concrete Drizzle client
// whose transaction driver refuses access. No successful store admission is mocked.

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemPriorCandidateFrozen } from '@/capabilities/practice/server/item-prior-durable-operation';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { makePracticeTaskRunFn } from '@/capabilities/practice/server/task-runtime';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import { item_calibration, knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { defaultSubjectProfile } from '@/subjects/profile';
import {
  ITEM_PRIOR_MEMBER,
  type ItemPriorAdmission,
  type ItemPriorDispatchedAdmission,
  ItemPriorDurabilityPrerequisiteError,
  type ItemPriorExecutionStepRunner,
  ItemPriorMemberIdentityError,
  type ItemPriorStepRunner,
  itemPriorDispatchedRequestSchema,
  runItemPriorDurableMember,
  runItemPriorDurableMemberExecution,
} from './item-prior-family';

vi.mock('@/capabilities/practice/server/task-runtime', () => ({
  makePracticeTaskRunFn: vi.fn(),
}));
vi.mock('@/kernel/read-models/subject-profile', () => ({
  resolveSubjectProfileForKnowledgeIds: vi.fn(),
}));
vi.mock('@/server/mastery/item-calibration', () => ({
  applyItemPrior: vi.fn(),
}));

const makeRunFnMock = vi.mocked(makePracticeTaskRunFn);
const resolveProfileMock = vi.mocked(resolveSubjectProfileForKnowledgeIds);
const applyItemPriorMock = vi.mocked(applyItemPrior);

/** In-memory hard-row store the (overridden) applyItemPrior mock writes into. */
let calibrationRows: Array<{
  question_id: string;
  b: number;
  bAnchor: number;
  confidence: number;
  source: string;
}>;

beforeEach(() => {
  // Clear call records only (implementations below are re-set every test).
  vi.clearAllMocks();
  calibrationRows = [];
  // Defaults preserve the blocked-candidate contract: no paid dispatch, no
  // calibration write. Admission resolves subject profiles on purpose —
  // frozen paid inputs, not paid execution.
  makeRunFnMock.mockImplementation(() => {
    throw new Error('Paid dispatch must remain blocked');
  });
  resolveProfileMock.mockResolvedValue(defaultSubjectProfile);
  applyItemPriorMock.mockImplementation(async () => {
    throw new Error('Candidate must not write calibration');
  });
});

const request = {
  member: ITEM_PRIOR_MEMBER,
  dagRunId: 'run_1',
  runDate: '2026-10-11',
  nodeId: 'node_ipb',
};

function database(
  overrides: {
    runDate?: string;
    nodeId?: string;
    bossState?: string;
    candidates?: ItemPriorCandidateFrozen[];
  } = {},
) {
  const candidates = overrides.candidates ?? [
    {
      id: 'q_boundary',
      kind: 'short_answer',
      prompt_md: '分类讨论\n'.repeat(40),
      reference_md: '保留边界条件',
      choices_md: null,
      knowledge_ids: ['kc_boundary', 'kc_missing'],
    },
  ];
  let selects = 0;
  // Shared read chain: admission uses it through tx, application verification
  // through db. item_calibration reads return the test store as-is (the real
  // query filters question_id + track; tests keep at most one applied row
  // readable at a time).
  const selectChain = () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === question) {
          selects++;
          return { limit: async () => structuredClone(candidates) };
        }
        if (table === knowledge) return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
        if (table === item_calibration)
          return Promise.resolve(
            structuredClone(
              calibrationRows.map(({ b, bAnchor, confidence, source }) => ({
                b,
                bAnchor,
                confidence,
                source,
              })),
            ),
          );
        throw new Error('Unexpected table');
      },
    }),
  });
  const tx = {
    execute: async (query: SQL) => {
      const { sql: text } = new PgDialect().sqlToQuery(query);
      if (text.includes('dag_orchestration_run'))
        return [
          {
            id: request.dagRunId,
            run_date: overrides.runDate ?? request.runDate,
            status: 'running',
          },
        ];
      if (text.includes('dag_orchestration_node'))
        return [
          {
            id: overrides.nodeId ?? request.nodeId,
            status: 'pending',
            boss_job_id: overrides.bossState ? '11111111-1111-1111-1111-111111111111' : null,
          },
        ];
      if (text.includes('pgboss.job')) return [{ state: overrides.bossState }];
      throw new Error('Unexpected database operation');
    },
    select: selectChain,
  };
  // Only this read-chain test boundary substitutes for a Drizzle database.
  const db = {
    transaction: async (fn: (tx: Tx) => Promise<ItemPriorAdmission>) => fn(tx as unknown as Tx),
    select: selectChain,
  } as unknown as Db;
  return { db, candidates, selects: () => selects };
}

function steps() {
  // DBOS identifies steps by sequence position and validates the function name.
  // This one-step double checks position/name; it is not a runtime replay proof.
  let recorded: { name: string; admission: ItemPriorAdmission } | undefined;
  const runner: ItemPriorStepRunner = {
    async runStep(name, fn) {
      if (recorded) {
        if (recorded.name !== name) throw new Error('Unexpected step at position 0');
        return structuredClone(recorded.admission);
      }
      const admission = await fn();
      recorded = { name, admission: structuredClone(admission) };
      return admission;
    },
  };
  return runner;
}

const noGate = async () => {};

async function blockedAdmission(db: Db, runner: ItemPriorStepRunner): Promise<ItemPriorAdmission> {
  try {
    await runItemPriorDurableMember({ db, steps: runner, request, gateEpoch: noGate });
    throw new Error('Candidate unexpectedly completed');
  } catch (error) {
    if (!(error instanceof ItemPriorDurabilityPrerequisiteError)) throw error;
    expect(error.code).toBe('ITEM_PRIOR_DURABLE_PREREQUISITE');
    return error.admission;
  }
}

describe('item prior candidate prerequisite', () => {
  // @invariant concurrency: a recorded member admission cannot be replaced by a later candidate set
  // @fails-if replay reselects candidates or returns success instead of retaining the prerequisite error
  it('keeps the frozen member and batch blocked on initial execution and recorded-step replay', async () => {
    const fixture = database();
    const runner = steps();
    const initial = await blockedAdmission(fixture.db, runner);
    expect(initial.identity).toEqual(request);
    expect(initial.params).toEqual({ method: 'feature', reps: 3 });
    expect(initial.candidates.map(({ id }) => id)).toEqual(['q_boundary']);
    fixture.candidates.splice(0);
    const replay = await blockedAdmission(fixture.db, runner);
    expect(replay).toEqual(initial);
    expect(fixture.selects()).toBe(1);
    // An empty fresh admission is also a blocked candidate, not a discharged node.
    const empty = await blockedAdmission(fixture.db, steps());
    expect(empty.candidates).toEqual([]);
  });

  // @invariant concurrency: admission cannot take ownership from a retained active pg-boss job
  // @fails-if the live-job check is removed; the result changes from identity rejection to admission
  it('rejects an active retained job before freezing candidates', async () => {
    const fixture = database({ bossState: 'active' });
    await expect(
      runItemPriorDurableMember({
        db: fixture.db,
        steps: steps(),
        request,
        gateEpoch: noGate,
      }),
    ).rejects.toThrow('still owns node');
    expect(fixture.selects()).toBe(0);
  });

  // @invariant concurrency: a member admission must match the exact run date and node identity
  // @fails-if either identity check is removed; the mismatched member reaches the prerequisite error
  it('rejects mismatched dates and node IDs before recording admission', async () => {
    for (const overrides of [{ runDate: '2026-10-12' }, { nodeId: 'other_node' }]) {
      const fixture = database(overrides);
      await expect(
        runItemPriorDurableMember({
          db: fixture.db,
          steps: steps(),
          request,
          gateEpoch: noGate,
        }),
      ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
      expect(fixture.selects()).toBe(0);
    }
  });
});

const dispatchedRequest = {
  ...request,
  dispatch: {
    version: 1,
    backend: 'pg-boss',
    deliveryId: 'original_delivery',
    tickId: request.dagRunId,
    generation: 0,
  },
} as const;

function frozenExecutionSteps(
  admission: ItemPriorDispatchedAdmission,
): ItemPriorExecutionStepRunner {
  return {
    async runStep(name) {
      expect(name).toBe('item-prior-dispatched-admission-v1');
      return structuredClone(admission);
    },
  };
}

describe('item prior original dispatched identity', () => {
  // @invariant concurrency: unversioned jobs cannot acquire a current generation at consumption
  // @fails-if dispatch generation becomes optional or tick identity is independent of the frozen DAG run
  it('rejects legacy requests and mismatched dispatch ticks before any database or provider access', async () => {
    const fixture = database();
    const admission = await blockedAdmission(fixture.db, steps());
    const provider = vi.fn(async () => ({ text: '' }));
    for (const bad of [
      request,
      { ...dispatchedRequest, dispatch: { ...dispatchedRequest.dispatch, generation: undefined } },
      { ...dispatchedRequest, dispatch: { ...dispatchedRequest.dispatch, tickId: 'other_dag' } },
    ]) {
      await expect(
        runItemPriorDurableMemberExecution({
          db: fixture.db,
          request: bad,
          steps: frozenExecutionSteps({ ...admission, dispatch: dispatchedRequest.dispatch }),
          runTaskFn: provider,
          gateEpoch: noGate,
        }),
      ).rejects.toThrow();
    }
    expect(provider).not.toHaveBeenCalled();
    expect(applyItemPriorMock).not.toHaveBeenCalled();
    expect(itemPriorDispatchedRequestSchema.parse(dispatchedRequest)).toEqual(dispatchedRequest);
  });

  // @invariant concurrency: replay keeps the original dispatch rather than reading current control
  // @fails-if a recorded old generation is silently replaced by the new request's generation
  it('rejects a changed generation on recorded-step replay', async () => {
    const fixture = database();
    const admission = await blockedAdmission(fixture.db, steps());
    const provider = vi.fn(async () => ({ text: '' }));
    await expect(
      runItemPriorDurableMemberExecution({
        db: fixture.db,
        request: {
          ...dispatchedRequest,
          dispatch: { ...dispatchedRequest.dispatch, generation: 1 },
        },
        steps: frozenExecutionSteps({ ...admission, dispatch: dispatchedRequest.dispatch }),
        runTaskFn: provider,
        gateEpoch: noGate,
      }),
    ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
    expect(provider).not.toHaveBeenCalled();
  });

  // @invariant data: actual store transaction errors propagate before a physical send
  // @fails-if the execution path still calls an injected always-admitted port or isolates a store failure
  it('calls the real shared store and propagates its transaction driver failure', async () => {
    const fixture = database();
    const admission = await blockedAdmission(fixture.db, steps());
    // postgres-js connects lazily. The first transaction is rejected by the driver,
    // so no socket, SQL lock, database, credential or provider is used here.
    const client = postgres({ host: 'unit.invalid', port: 1 });
    const begin = vi
      .spyOn(client, 'begin')
      .mockRejectedValue(new Error('unit transaction unavailable'));
    const db = drizzle(client, { schema });
    const provider = vi.fn(async () => ({ text: '' }));
    try {
      await expect(
        runItemPriorDurableMemberExecution({
          db,
          request: dispatchedRequest,
          steps: frozenExecutionSteps({ ...admission, dispatch: dispatchedRequest.dispatch }),
          runTaskFn: provider,
          gateEpoch: noGate,
        }),
      ).rejects.toMatchObject({
        code: 'ITEM_PRIOR_DURABLE_STORE',
        reason: { message: 'unit transaction unavailable' },
      });
      expect(begin).toHaveBeenCalledTimes(1);
      expect(provider).not.toHaveBeenCalled();
      expect(applyItemPriorMock).not.toHaveBeenCalled();
    } finally {
      await client.end();
    }
  });
});
