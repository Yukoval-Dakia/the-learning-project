// Prepared for the parent's DB partition; not run by this offline lane.
// Real Postgres admission checks, one-step double, no DBOS runtime or provider.
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  dag_orchestration_node,
  dag_orchestration_run,
  item_calibration,
  question,
} from '@/db/schema';
import {
  ITEM_PRIOR_MEMBER,
  type ItemPriorAdmission,
  ItemPriorDurabilityPrerequisiteError,
  ItemPriorMemberIdentityError,
  type ItemPriorStepRunner,
  runItemPriorDurableMember,
} from '@/server/durable/item-prior-family';
import { resetDb, testDb } from '../helpers/db';

const db = testDb();
const request = {
  member: ITEM_PRIOR_MEMBER,
  dagRunId: 'run_itemprior_dbtest',
  nodeId: 'node_itemprior_dbtest',
  runDate: '2026-10-11',
};
const noGate = async () => {};

function steps(): ItemPriorStepRunner {
  let recorded: { name: string; admission: ItemPriorAdmission } | undefined;
  return {
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
}

async function seedDagRun(runDate = request.runDate) {
  const now = new Date();
  await db.insert(dag_orchestration_run).values({
    id: request.dagRunId,
    run_date: runDate,
    trigger: 'cron',
    status: 'running',
    started_at: now,
    updated_at: now,
  });
  await db.insert(dag_orchestration_node).values({
    id: request.nodeId,
    run_id: request.dagRunId,
    job_name: ITEM_PRIOR_MEMBER,
    status: 'pending',
    stale: false,
    updated_at: now,
  });
}

async function seedQuestion(id: string) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `题目 ${id}: 分类讨论与边界条件。\n`.repeat(40),
    reference_md: '先讨论一般情况，再讨论退化情况。',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function blockedAdmission(runner: ItemPriorStepRunner): Promise<ItemPriorAdmission> {
  try {
    await runItemPriorDurableMember({ db, steps: runner, request, gateEpoch: noGate });
    throw new Error('Candidate unexpectedly completed');
  } catch (error) {
    if (!(error instanceof ItemPriorDurabilityPrerequisiteError)) throw error;
    return error.admission;
  }
}

beforeEach(async () => {
  await resetDb();
});

describe('item prior blocked candidate (DB)', () => {
  // @invariant concurrency: recorded admission freezes the uncalibrated batch without settling it
  // @fails-if replay reselects changed questions, anti-join admits hard rows, or the candidate writes anchors
  it('freezes the real anti-join result, leaves anchors unchanged, and stays blocked on replay', async () => {
    await seedDagRun();
    for (const id of ['q_done', 'q_a', 'q_b']) await seedQuestion(id);
    const now = new Date();
    await db.insert(item_calibration).values({
      id: createId(),
      question_id: 'q_done',
      b: -0.5,
      confidence: 0.9,
      track: 'hard',
      source: 'fixed_anchor',
      created_at: now,
      updated_at: now,
    });
    const before = await db.select().from(item_calibration);
    const runner = steps();
    const initial = await blockedAdmission(runner);
    expect(initial.identity).toEqual(request);
    expect(initial.params).toEqual({ method: 'feature', reps: 3 });
    expect(initial.candidates.map(({ id }) => id).sort()).toEqual(['q_a', 'q_b']);
    await seedQuestion('q_later');
    await db
      .update(question)
      .set({ prompt_md: 'changed after admission' })
      .where(eq(question.id, 'q_a'));
    const replay = await blockedAdmission(runner);
    expect(replay).toEqual(initial);
    expect(await db.select().from(item_calibration)).toEqual(before);
    const nodes = await db.select().from(dag_orchestration_node);
    expect(nodes.map(({ id, status, boss_job_id }) => ({ id, status, boss_job_id }))).toEqual([
      { id: request.nodeId, status: 'pending', boss_job_id: null },
    ]);
  });

  // @invariant concurrency: only the exact DAG run date and node can be admitted
  // @fails-if the run-date or node-id check is removed; identity rejection becomes prerequisite admission
  it('rejects mismatched dates and node IDs without settling a node', async () => {
    await seedDagRun();
    for (const mismatch of [{ runDate: '2026-10-12' }, { nodeId: 'other_node' }]) {
      await expect(
        runItemPriorDurableMember({
          db,
          steps: steps(),
          request: { ...request, ...mismatch },
          gateEpoch: noGate,
        }),
      ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
    }
    expect(await db.select().from(item_calibration)).toEqual([]);
    const [node] = await db.select().from(dag_orchestration_node);
    expect(node?.status).toBe('pending');
  });
});
