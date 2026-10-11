// Prepared for the parent's DB partition; not run by this offline lane.
// Real Postgres admission checks, one-step double, no DBOS runtime or provider.
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ItemPriorStagedItem,
  commitItemPriorStagedCalibration,
} from '@/capabilities/practice/server/item-prior-durable-operation';
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

// Prepared real-PG float4 check for the application seam (R1 P1); NOT run by
// this offline lane — the parent executes the DB partition. Real `real`
// columns, real applyItemPrior write, no provider, no DBOS runtime.
describe('item prior application float4 verification (DB, prepared)', () => {
  function stagedFor(questionId: string, bLogit: number, confidence: number): ItemPriorStagedItem {
    const draft = { b_logit: bLogit, confidence, reasoning: '真实 float4 存储往返断言' };
    return {
      questionId,
      questionRevision: `rev_${questionId}`,
      inputDigest: `digest_${questionId}`,
      method: 'feature',
      repOutcomes: [{ state: 'draft', draft }],
      status: 'ready',
      draft,
      source: 'llm_prior',
      heldReps: [],
      pendingReps: [],
    };
  }

  // @invariant grading: PG real (float4) legally shortens even-count medians — a fresh anchor must verify applied
  // @fails-if the comparison uses strict double equality or a broad epsilon
  it('applies, re-verifies and supersedes across real float4 columns', async () => {
    await seedQuestion('q_f4_pg');
    const evenMedian = (0.1 + 0.2) / 2; // double 0.15000000000000002
    const staged = stagedFor('q_f4_pg', evenMedian, 1 / 3);

    expect(await commitItemPriorStagedCalibration(db, staged)).toEqual({ status: 'applied' });
    // Stored at float4 precision, not the double:
    const [row] = await db
      .select({ b: item_calibration.b, b_anchor: item_calibration.b_anchor })
      .from(item_calibration)
      .where(eq(item_calibration.question_id, 'q_f4_pg'));
    if (!row) throw new Error('Applied calibration row was not persisted');
    // The text driver may return the shortest decimal (0.15), not the exact
    // float32 value widened to double. Compare the stored float32 bits.
    expect(Math.fround(row.b)).toBe(Math.fround(evenMedian));
    expect(row?.b).not.toBe(evenMedian);

    // Idempotent replay from the persisted float4 row, no second write:
    expect(await commitItemPriorStagedCalibration(db, staged)).toEqual({ status: 'applied' });

    // A genuinely different anchor stays superseded at float4 precision:
    const differing = stagedFor('q_f4_pg', 1.234568, 1 / 3);
    const verification = await commitItemPriorStagedCalibration(db, differing);
    expect(verification).toMatchObject({ status: 'superseded' });
  });
});
