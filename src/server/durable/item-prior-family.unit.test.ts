// Offline checks of the blocked candidate, not DBOS crash/recovery acceptance.
// The execution-path checks drive the per-rep seams behind a protocol-faithful
// port double; default mock implementations keep the blocked-candidate proofs
// (no paid dispatch, no profile resolution, no calibration write).

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ItemPriorCandidateFrozen,
  ItemPriorRepAdmission,
  ItemPriorRepEffectPort,
  ItemPriorRepIdentity,
  ItemPriorRepReceipt,
  ItemPriorRepRecord,
} from '@/capabilities/practice/server/item-prior-durable-operation';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/practice/server/knowledge-runtime';
import { makePracticeTaskRunFn } from '@/capabilities/practice/server/task-runtime';
import { stableStringify } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { defaultSubjectProfile } from '@/subjects/profile';
import {
  ITEM_PRIOR_MEMBER,
  type ItemPriorAdmission,
  ItemPriorDurabilityPrerequisiteError,
  ItemPriorMemberIdentityError,
  type ItemPriorStepRunner,
  runItemPriorDurableMember,
  runItemPriorDurableMemberExecution,
} from './item-prior-family';

vi.mock('@/capabilities/practice/server/task-runtime', () => ({
  makePracticeTaskRunFn: vi.fn(),
}));
vi.mock('@/capabilities/practice/server/knowledge-runtime', () => ({
  resolveSubjectProfileForKnowledgeIds: vi.fn(),
}));
vi.mock('@/server/mastery/item-calibration', () => ({
  applyItemPrior: vi.fn(),
}));

const makeRunFnMock = vi.mocked(makePracticeTaskRunFn);
const resolveProfileMock = vi.mocked(resolveSubjectProfileForKnowledgeIds);
const applyItemPriorMock = vi.mocked(applyItemPrior);

beforeEach(() => {
  // Clear call records only (implementations below are re-set every test).
  vi.clearAllMocks();
  // Defaults preserve the blocked-candidate contract; execution-path tests
  // override exactly the seams they drive.
  makeRunFnMock.mockImplementation(() => {
    throw new Error('Paid dispatch must remain blocked');
  });
  resolveProfileMock.mockImplementation(async () => {
    throw new Error('Candidate must not resolve paid execution context');
  });
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
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === question) {
            selects++;
            return { limit: async () => structuredClone(candidates) };
          }
          if (table === knowledge)
            return Promise.resolve([{ id: 'kc_boundary', name: '边界条件' }]);
          throw new Error('Unexpected table');
        },
      }),
    }),
  };
  // Only this read-chain test boundary substitutes for a Drizzle database.
  const db = {
    transaction: async (fn: (tx: Tx) => Promise<ItemPriorAdmission>) => fn(tx as unknown as Tx),
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

// ─── YUK-1355 — execution behind the provisional shared port ────────────────

/** Same protocol-faithful double as the operation tests: work-identity keys,
 * single-shot completion, records persist across deliveries. */
class PortDouble implements ItemPriorRepEffectPort {
  readonly records = new Map<string, ItemPriorRepRecord>();
  readonly admits: Array<{ identity: ItemPriorRepIdentity; decision: ItemPriorRepAdmission }> = [];
  readonly completes: Array<{ identity: ItemPriorRepIdentity; receipt: ItemPriorRepReceipt }> = [];
  admitOverride: ((identity: ItemPriorRepIdentity) => ItemPriorRepAdmission) | undefined;

  getRecord(identity: ItemPriorRepIdentity): ItemPriorRepRecord | undefined {
    const record = this.records.get(stableStringify(identity));
    return record === undefined ? undefined : structuredClone(record);
  }

  lookupRep: ItemPriorRepEffectPort['lookupRep'] = async (identity) => this.getRecord(identity);

  admitRep: ItemPriorRepEffectPort['admitRep'] = async (identity) => {
    const decision: ItemPriorRepAdmission = this.records.has(stableStringify(identity))
      ? { decision: 'held' }
      : (this.admitOverride?.(identity) ?? { decision: 'admitted' });
    this.admits.push({ identity: { ...identity }, decision });
    return decision;
  };

  completeRep: ItemPriorRepEffectPort['completeRep'] = async (identity, receipt) => {
    const key = stableStringify(identity);
    if (this.records.has(key)) {
      throw new Error('PortDouble: immutable-receipt violation (second completion)');
    }
    this.records.set(
      key,
      receipt.kind === 'output'
        ? { state: 'output', outputText: receipt.outputText }
        : { state: 'unknown' },
    );
    this.completes.push({ identity: { ...identity }, receipt: structuredClone(receipt) });
  };
}

function row(id: string): ItemPriorCandidateFrozen {
  return {
    id,
    kind: 'short_answer',
    prompt_md: `题干 ${id}：比较两种解法的条件与结论。\n`.repeat(40),
    reference_md: '先分类讨论，再检查边界条件。',
    choices_md: null,
    knowledge_ids: ['kc_boundary'],
  };
}

function text(b: number, confidence: number): string {
  return JSON.stringify({ b_logit: b, confidence, reasoning: '嵌套分类讨论与边界检查' });
}

describe('item prior durable member execution behind the shared port', () => {
  // @invariant grading: frozen query order drives execution and only settled items are applied
  // @fails-if held items throw, block later items, or get written despite unresolved reps
  it('applies settled items in frozen query order and counts held items without throwing', async () => {
    resolveProfileMock.mockResolvedValue(defaultSubjectProfile);
    applyItemPriorMock.mockImplementation(async () => {});
    const fixture = database({ candidates: [row('q_a'), row('q_b')] });
    const port = new PortDouble();
    const outputs = [
      text(0.2, 0.3),
      text(1.2, 0.5),
      text(0.8, 0.6), // q_a median b=0.8
      text(-0.4, 0.2),
      new Error('socket reset after physical dispatch; outcome unknown'),
      text(7, 0.5), // q_b: rep 1 unknown → held
    ];
    let providerCalls = 0;
    const runTaskFn = async () => {
      providerCalls++;
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { text: output ?? '' };
    };

    const result = await runItemPriorDurableMemberExecution({
      db: fixture.db,
      steps: steps(),
      request,
      port,
      runTaskFn,
      gateEpoch: noGate,
    });

    expect(result.identity).toEqual(request); // delivery identity reported, distinct from rep identities
    expect(result.considered).toBe(2);
    expect(result.applied).toBe(1);
    expect(result.held).toBe(1);
    expect(providerCalls).toBe(6);
    expect(applyItemPriorMock.mock.calls.map(([, input]) => input.questionId)).toEqual(['q_a']);
    expect(applyItemPriorMock.mock.calls[0]?.[1].draft.b_logit).toBe(0.8);
    expect(applyItemPriorMock.mock.calls[0]?.[1].source).toBe('llm_prior');
    expect(result.items.map((item) => [item.questionId, item.status])).toEqual([
      ['q_a', 'ready'],
      ['q_b', 'held'],
    ]);
    expect(makeRunFnMock).not.toHaveBeenCalled(); // no manufactured default dispatch
  });

  // @invariant durability: an unknown rep stays held across a new nightly delivery without re-send
  // @fails-if a later delivery re-admits or re-sends the unknown rep, or treats it as retryable
  it('keeps an unknown rep held across a new nightly delivery without provider re-send', async () => {
    resolveProfileMock.mockResolvedValue(defaultSubjectProfile);
    applyItemPriorMock.mockImplementation(async () => {});
    const night1 = database({ candidates: [row('q_hold')] });
    const port = new PortDouble();
    const outputs = [
      text(0.2, 0.3),
      new Error('dropped connection; paid outcome unknown'),
      text(0.8, 0.6),
    ];
    let providerCalls = 0;
    const runTaskFn = async () => {
      providerCalls++;
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { text: output ?? '' };
    };
    const first = await runItemPriorDurableMemberExecution({
      db: night1.db,
      steps: steps(),
      request,
      port,
      runTaskFn,
      gateEpoch: noGate,
    });
    expect(first.held).toBe(1);
    expect(providerCalls).toBe(3);
    const heldComplete = port.completes.find(({ receipt }) => receipt.kind === 'unknown');
    if (!heldComplete) throw new Error('night 1 must have recorded an unknown receipt');
    const heldIdentity = heldComplete.identity;
    const admitsAfterNight1 = port.admits.length;

    // New night, new delivery identity; the anti-join still returns the
    // uncalibrated question, and every staged rep must replay from the port.
    const night2 = database({ runDate: '2026-10-12', candidates: [row('q_hold')] });
    const hostile = async (): Promise<{ text: string }> => {
      throw new Error('provider must not be re-sent');
    };
    const second = await runItemPriorDurableMemberExecution({
      db: night2.db,
      steps: steps(),
      request: { ...request, dagRunId: 'run_2', runDate: '2026-10-12' },
      port,
      runTaskFn: hostile,
      gateEpoch: noGate,
    });

    expect(second.considered).toBe(1);
    expect(second.held).toBe(1);
    expect(second.applied).toBe(0);
    expect(providerCalls).toBe(3); // unchanged — no re-send on the new delivery
    expect(port.admits).toHaveLength(admitsAfterNight1); // resume via lookup only
    expect(port.getRecord(heldIdentity)).toEqual({ state: 'unknown' }); // same work identity, still held
    expect(Object.keys(heldIdentity).sort()).toEqual([
      'inputDigest',
      'method',
      'questionId',
      'questionRevision',
      'repIndex',
    ]);
  });

  // @invariant concurrency: a preparation failure isolates its item without blocking later items
  // @fails-if an item-level preparation error aborts the member or is miscounted as held/applied
  it('isolates a preparation failure per item without blocking later items', async () => {
    resolveProfileMock
      .mockImplementationOnce(async () => {
        throw new Error('profile read failed');
      })
      .mockResolvedValue(defaultSubjectProfile);
    applyItemPriorMock.mockImplementation(async () => {});
    const fixture = database({ candidates: [row('q_a'), row('q_b')] });
    const port = new PortDouble();
    const outputs = [text(0.2, 0.3), text(0.8, 0.6), text(1.2, 0.5)];
    const runTaskFn = async () => ({ text: outputs.shift() ?? '' });

    const result = await runItemPriorDurableMemberExecution({
      db: fixture.db,
      steps: steps(),
      request,
      port,
      runTaskFn,
      gateEpoch: noGate,
    });

    expect(result.considered).toBe(2);
    expect(result.skippedError).toBe(1);
    expect(result.applied).toBe(1);
    expect(applyItemPriorMock.mock.calls.map(([, input]) => input.questionId)).toEqual(['q_b']);
  });
});
