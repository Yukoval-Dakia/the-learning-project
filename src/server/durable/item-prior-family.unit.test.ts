// Offline checks of the blocked candidate, not DBOS crash/recovery acceptance.

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import {
  ITEM_PRIOR_MEMBER,
  type ItemPriorAdmission,
  ItemPriorDurabilityPrerequisiteError,
  ItemPriorMemberIdentityError,
  type ItemPriorStepRunner,
  runItemPriorDurableMember,
} from './item-prior-family';

vi.mock('@/capabilities/practice/server/task-runtime', () => ({
  makePracticeTaskRunFn: () => {
    throw new Error('Paid dispatch must remain blocked');
  },
}));
vi.mock('@/capabilities/practice/server/knowledge-runtime', () => ({
  resolveSubjectProfileForKnowledgeIds: () => {
    throw new Error('Candidate must not resolve paid execution context');
  },
}));
vi.mock('@/server/mastery/item-calibration', () => ({
  applyItemPrior: () => {
    throw new Error('Candidate must not write calibration');
  },
}));

const request = {
  member: ITEM_PRIOR_MEMBER,
  dagRunId: 'run_1',
  runDate: '2026-10-11',
  nodeId: 'node_ipb',
};

function database(overrides: { runDate?: string; nodeId?: string; bossState?: string } = {}) {
  const candidates = [
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
