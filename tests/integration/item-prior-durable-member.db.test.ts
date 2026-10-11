// Prepared for the parent's DB partition; not run by this offline lane.
// Real Postgres admission checks, one-step double, no DBOS runtime or provider.
import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type ItemPriorPreparedWork,
  type ItemPriorStagedItem,
  commitItemPriorStagedCalibration,
  executeItemPriorRep,
  prepareItemPriorWork,
  runItemPriorItemRepStages,
} from '@/capabilities/practice/server/item-prior-durable-operation';
import {
  dag_orchestration_node,
  dag_orchestration_run,
  item_calibration,
  paid_effect,
  paid_effect_control,
  question,
} from '@/db/schema';
import {
  ITEM_PRIOR_MEMBER,
  type ItemPriorAdmission,
  type ItemPriorDispatchedAdmission,
  ItemPriorDurabilityPrerequisiteError,
  type ItemPriorExecutionStepRunner,
  ItemPriorMemberIdentityError,
  ItemPriorMemberIncompleteError,
  type ItemPriorStepRunner,
  itemPriorDispatchedRequestSchema,
  runItemPriorDurableMember,
  runItemPriorDurableMemberExecution,
} from '@/server/durable/item-prior-family';
import {
  ItemPriorPaidEffectAdapter,
  itemPriorPaidEffectInput,
  itemPriorPaidEffectRevision,
} from '@/server/durable/item-prior-paid-effect-adapter';
import {
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
} from '@/server/durable/paid-effect-protocol';
import { readPaidEffect, recordPaidEffectApplication } from '@/server/durable/paid-effect-store';
import { setFixedAnchor } from '@/server/mastery/fixed-anchor';
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

    expect(await commitItemPriorStagedCalibration(db, staged)).toEqual({ status: 'matched' });
    // Stored at float4 precision, not the double:
    const [row] = await db
      .select({ b: item_calibration.b, b_anchor: item_calibration.b_anchor })
      .from(item_calibration)
      .where(eq(item_calibration.question_id, 'q_f4_pg'));
    if (!row || row.b === null) throw new Error('Matched calibration row was not persisted');
    // The text driver may return the shortest decimal (0.15), not the exact
    // float32 value widened to double. Compare the stored float32 bits.
    expect(Math.fround(row.b)).toBe(Math.fround(evenMedian));
    expect(row?.b).not.toBe(evenMedian);

    // Idempotent replay from the persisted float4 row, no second write:
    expect(await commitItemPriorStagedCalibration(db, staged)).toEqual({ status: 'matched' });

    // A genuinely different anchor stays superseded at float4 precision:
    const differing = stagedFor('q_f4_pg', 1.234568, 1 / 3);
    const verification = await commitItemPriorStagedCalibration(db, differing);
    expect(verification).toMatchObject({ status: 'superseded' });
  });
});

// Every case below uses the concrete adapter + fixed B store + real Postgres.
// The task runner is an offline output fixture. These cases are PREPARED, NOT RUN by this lane.
const originalDispatch = {
  version: 1,
  backend: 'pg-boss',
  deliveryId: '11111111-1111-4111-8111-111111111111',
  tickId: request.dagRunId,
  generation: 0,
} as const;

let fixtureBoss: PgBoss | undefined;
const ownedJobs: Array<{ name: string; id: string }> = [];

async function createActiveDispatchedJob(
  rawRequest: unknown,
  storedPayload?: object,
  name = ITEM_PRIOR_MEMBER,
) {
  const dispatched = itemPriorDispatchedRequestSchema.parse(rawRequest);
  if (!fixtureBoss) {
    const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
    if (
      !/^\/test_fork_\d+$/.test(url.pathname) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error('Disposable fork DB required');
    fixtureBoss = new PgBoss({
      connectionString: url.toString(),
      max: 2,
      supervise: false,
      schedule: false,
    });
    fixtureBoss.on('error', () => {});
    await fixtureBoss.start();
  }
  await fixtureBoss.createQueue(name);
  const jobId = await fixtureBoss.send(name, storedPayload ?? dispatched, {
    id: dispatched.dispatch.deliveryId,
  });
  if (!jobId) throw new Error('Fixture job was not enqueued');
  ownedJobs.push({ name, id: jobId });
  const [job] = await fixtureBoss.fetch(name, { includeMetadata: true });
  if (job?.id !== jobId || job.state !== 'active')
    throw new Error('Fixture must fetch the exact job into active state');

  return dispatched;
}

async function seedDispatchedNode(
  rawRequest: unknown,
  storedPayload?: object,
  name = ITEM_PRIOR_MEMBER,
) {
  const dispatched = await createActiveDispatchedJob(rawRequest, storedPayload, name);
  await db
    .update(dag_orchestration_node)
    .set({ boss_job_id: dispatched.dispatch.deliveryId, status: 'enqueued' })
    .where(eq(dag_orchestration_node.id, dispatched.nodeId));
  return dispatched;
}

afterEach(async () => {
  for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
});
afterAll(async () => {
  await fixtureBoss?.stop();
});

function executionSteps() {
  let recorded: ItemPriorDispatchedAdmission | undefined;
  const runner: ItemPriorExecutionStepRunner = {
    async runStep(name, fn) {
      if (name !== 'item-prior-dispatched-admission-v1')
        throw new Error('Unexpected dispatch step');
      if (recorded) return structuredClone(recorded);
      recorded = structuredClone(await fn());
      return structuredClone(recorded);
    },
  };
  return { runner, admission: () => recorded };
}

async function realWork(id: string, reps = 3): Promise<ItemPriorPreparedWork> {
  const [candidate] = await db.select().from(question).where(eq(question.id, id));
  if (!candidate) throw new Error('Missing prepared question');
  // The frozen candidate is exactly the admission projection, excluding mutable metadata.
  return prepareItemPriorWork(
    db,
    {
      id: candidate.id,
      kind: candidate.kind,
      prompt_md: candidate.prompt_md,
      reference_md: candidate.reference_md,
      choices_md: candidate.choices_md,
      knowledge_ids: candidate.knowledge_ids,
    },
    new Map(),
    { method: 'feature', reps },
  );
}

function output(b: number, confidence = 1 / 3) {
  return JSON.stringify({
    b_logit: b,
    confidence,
    reasoning: '分类、退化与边界，保留不可变原始结果。\n'.repeat(40),
  });
}

const noProvider = async (): Promise<{ text: string }> => {
  throw new Error('Receipts and held effects must not call the provider');
};

function effectIdentity(work: ItemPriorPreparedWork, rep = 0) {
  return computePaidEffectIdentity(itemPriorPaidEffectInput(work, rep));
}

describe('item prior concrete shared-store consumer (DB, prepared)', () => {
  // @invariant concurrency: exactly one reservation wins and only its exact fence/delivery can persist output
  // @fails-if two reserve calls win, a stale fence completes, or a completed result is physically sent again
  it('reserves once under a real store race and completes only with the exact winning fence', async () => {
    await seedQuestion('q_adapter_race');
    const work = await realWork('q_adapter_race', 1);
    const a = new ItemPriorPaidEffectAdapter(db, originalDispatch);
    const b = new ItemPriorPaidEffectAdapter(db, { ...originalDispatch, deliveryId: 'other_job' });
    const reservations = await Promise.all([a.reserveRep(work, 0), b.reserveRep(work, 0)]);
    expect(reservations.map((r) => r.kind).sort()).toEqual(['held', 'winner']);
    const index = reservations.findIndex((r) => r.kind === 'winner');
    const winner = reservations[index];
    if (winner?.kind !== 'winner') throw new Error('Missing winner');
    const owner = index === 0 ? a : b;
    const loser = index === 0 ? b : a;
    const receipt = { version: 1, kind: 'output', outputText: output(0.15) } as const;
    await expect(
      owner.completeRep({ ...winner, fence: winner.fence + 1 }, receipt),
    ).rejects.toMatchObject({ name: 'PaidEffectDeliveryConflictError' });
    await expect(loser.completeRep(winner, receipt)).rejects.toMatchObject({
      name: 'PaidEffectDeliveryConflictError',
    });
    expect((await readPaidEffect(db, winner.identity))?.state).toBe('sending');
    await owner.completeRep(winner, receipt);
    const before = await readPaidEffect(db, winner.identity);
    expect(before).toMatchObject({ state: 'receipt_ready', fence: winner.fence, result: receipt });
    expect(
      await executeItemPriorRep(work, 0, { effects: loser, runTaskFn: noProvider }),
    ).toMatchObject({ state: 'draft', draft: { b_logit: 0.15 } });
    expect(await readPaidEffect(db, winner.identity)).toEqual(before);
    const [intent] = await db.select().from(paid_effect);
    expect(intent).toMatchObject({
      family: ITEM_PRIOR_MEMBER,
      entity_id: work.candidate.id,
      entity_revision: itemPriorPaidEffectRevision(work),
      unit: 'feature/rep:0',
      input_json: itemPriorPaidEffectInput(work, 0).input,
      input_digest: work.inputDigest,
    });
  });

  // @invariant durability: frozen inputs and receipts replay without new calls and settle transactionally
  // @fails-if a profile/question edit rekeys replay, invalid results become unknown, or application receipts are absent
  it('runs the actual member, freezes provider arguments, and replays matched application receipts', async () => {
    await seedDagRun();
    await seedQuestion('q_adapter_median');
    const checkpoints = executionSteps();
    const outputs = [output(0.1), '{broken JSON', output(0.2)];
    const provider = vi.fn(async () => ({ text: outputs.shift() ?? '' }));
    const dispatchedRequest = await seedDispatchedNode({ ...request, dispatch: originalDispatch });
    const first = await runItemPriorDurableMemberExecution({
      db,
      request: dispatchedRequest,
      steps: checkpoints.runner,
      runTaskFn: provider,
      gateEpoch: noGate,
    });
    expect(first).toMatchObject({ matched: 1, held: 0, incomplete: 0, noAnchor: 0, superseded: 0 });
    expect('applied' in first).toBe(false);
    const work = checkpoints.admission()?.prepared[0];
    if (!work) throw new Error('Missing frozen work');
    expect(provider.mock.calls).toHaveLength(3);
    // Provider arguments and persisted digest use the same exact frozen envelope.
    for (const call of provider.mock.calls) {
      expect(call).toEqual([work.taskName, work.input, { subjectProfile: work.subjectProfile }]);
    }
    const before = await db.select().from(paid_effect);
    expect(before).toHaveLength(3);
    expect(before.every((r) => r.state === 'applied')).toBe(true);
    for (const row of before) {
      expect(row.input_digest).toBe(computePaidEffectInputDigest(row.input_json));
      expect(row.application_json).toMatchObject({
        version: 1,
        questionRevision: work.questionRevision,
        inputDigest: work.inputDigest,
        repCount: 3,
        disposition: { status: 'matched' },
        draft: { b_logit: (0.1 + 0.2) / 2 },
      });
    }
    const [anchor] = await db.select().from(item_calibration);
    if (!anchor || anchor.b === null) throw new Error('Missing median anchor');
    expect(Math.fround(anchor.b)).toBe(Math.fround((0.1 + 0.2) / 2));
    await db
      .update(question)
      .set({ prompt_md: 'changed after the recorded admission' })
      .where(eq(question.id, work.candidate.id));
    const replay = await runItemPriorDurableMemberExecution({
      db,
      request: dispatchedRequest,
      steps: checkpoints.runner,
      runTaskFn: noProvider,
      gateEpoch: noGate,
    });
    expect(replay).toEqual(first);
    expect(await db.select().from(paid_effect)).toEqual(before);
    expect(await db.select().from(item_calibration)).toEqual([anchor]);
    expect(await db.select().from(paid_effect_control)).toEqual([]); // bootstrap pg-boss; no cutover
    expect((await db.select().from(dag_orchestration_node))[0]?.status).toBe('enqueued');
  });

  // @invariant durability: unknowns remain unresolved across new nights, input/revision changes and rep expansion
  // @fails-if held completes the member, later siblings are sent over a held rep, or new frozen work bypasses unknown
  it('rejects member completion over unknowns and never sends on later nights or changed work', async () => {
    await seedDagRun();
    await seedQuestion('q_adapter_unknown');
    const checkpoints = executionSteps();
    await seedDispatchedNode({ ...request, dispatch: originalDispatch });
    const provider = vi.fn(async () => {
      throw new Error('transport failed after possible paid send');
    });
    let firstError: unknown;
    try {
      await runItemPriorDurableMemberExecution({
        db,
        request: { ...request, dispatch: originalDispatch },
        steps: checkpoints.runner,
        runTaskFn: provider,
        gateEpoch: noGate,
      });
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(ItemPriorMemberIncompleteError);
    expect(firstError).toMatchObject({
      result: { held: 1, matched: 0, items: [{ heldReps: [0], pendingReps: [1, 2] }] },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    const work = checkpoints.admission()?.prepared[0];
    if (!work) throw new Error('Missing frozen work');
    const unknown = await readPaidEffect(db, effectIdentity(work));
    expect(unknown).toMatchObject({
      state: 'unknown',
      delivery: { deliveryId: originalDispatch.deliveryId },
    });
    const nextRequest = {
      ...request,
      dagRunId: 'next_dag_run',
      nodeId: 'next_dag_node',
      runDate: '2026-10-12',
    };
    await db.insert(dag_orchestration_run).values({
      id: nextRequest.dagRunId,
      run_date: nextRequest.runDate,
      trigger: 'cron',
      status: 'running',
      started_at: new Date(),
      updated_at: new Date(),
    });
    await db.insert(dag_orchestration_node).values({
      id: nextRequest.nodeId,
      run_id: nextRequest.dagRunId,
      job_name: ITEM_PRIOR_MEMBER,
      status: 'pending',
      stale: false,
      updated_at: new Date(),
    });
    const nextDispatch = {
      ...originalDispatch,
      tickId: nextRequest.dagRunId,
      deliveryId: randomUUID(),
    };
    await seedDispatchedNode({ ...nextRequest, dispatch: nextDispatch });
    await expect(
      runItemPriorDurableMemberExecution({
        db,
        request: {
          ...nextRequest,
          dispatch: nextDispatch,
        },
        steps: executionSteps().runner,
        runTaskFn: noProvider,
        gateEpoch: noGate,
      }),
    ).rejects.toBeInstanceOf(ItemPriorMemberIncompleteError);
    const next = new ItemPriorPaidEffectAdapter(db, {
      ...originalDispatch,
      tickId: 'next_night',
      deliveryId: 'next_delivery',
    });
    expect(
      (await runItemPriorItemRepStages(work, { effects: next, runTaskFn: noProvider })).status,
    ).toBe('held');
    await expect(
      runItemPriorDurableMemberExecution({
        db,
        request: { ...request, dispatch: originalDispatch },
        steps: checkpoints.runner,
        runTaskFn: noProvider,
        gateEpoch: noGate,
      }),
    ).rejects.toBeInstanceOf(ItemPriorMemberIncompleteError);
    const alteredInput = {
      ...work,
      input: {
        prompt_md: work.candidate.prompt_md,
        kind: work.candidate.kind,
        knowledge_context: [{ name: 'changed knowledge context with the same frozen question' }],
      },
    };
    alteredInput.inputDigest = computePaidEffectInputDigest({
      version: 1,
      taskName: alteredInput.taskName,
      input: alteredInput.input,
      ctx: { subjectProfile: alteredInput.subjectProfile },
    });
    await db
      .update(question)
      .set({ prompt_md: 'revised question row' })
      .where(eq(question.id, work.candidate.id));
    const revised = await realWork(work.candidate.id);
    for (const changed of [alteredInput, revised, { ...work, repCount: 4 }]) {
      const reservation = await next.reserveRep(changed, 2);
      expect(reservation).toMatchObject({
        kind: 'held',
        state: 'pending',
        blockedBy: effectIdentity(work),
      });
      expect(
        (await runItemPriorItemRepStages(changed, { effects: next, runTaskFn: noProvider })).status,
      ).toBe('held');
    }
    expect(await readPaidEffect(db, effectIdentity(work))).toEqual(unknown);
    expect(await db.select().from(item_calibration)).toEqual([]);
    expect((await db.select().from(dag_orchestration_node))[0]?.status).toBe('enqueued');
  });

  // @invariant durability: partial application cannot be treated as terminal or repaired by a new domain write
  // @fails-if mixed receipt states complete, mutate a hard row, or resend immutable paid results
  it('holds mixed applied and unapplied receipts without domain writes or paid replay', async () => {
    await seedQuestion('q_adapter_rollback');
    const work = await realWork('q_adapter_rollback', 2);
    const effects = new ItemPriorPaidEffectAdapter(db, originalDispatch);
    const outputs = [output(0.1), output(0.2)];
    const provider = vi.fn(async () => ({ text: outputs.shift() ?? '' }));
    const staged = await runItemPriorItemRepStages(work, { effects, runTaskFn: provider });
    await db.transaction((tx) =>
      recordPaidEffectApplication(tx, effectIdentity(work), {
        incompatible_historical_application: true,
      }),
    );
    const before = await db.select().from(paid_effect);
    await expect(effects.commitStaged(work, staged)).rejects.toMatchObject({
      code: 'ITEM_PRIOR_APPLICATION',
      reason: { name: 'PaidEffectApplicationConflictError' },
    });
    expect(await db.select().from(item_calibration)).toEqual([]);
    expect(await db.select().from(paid_effect)).toEqual(before);
    expect((await readPaidEffect(db, effectIdentity(work, 1)))?.state).toBe('receipt_ready');
    expect(await runItemPriorItemRepStages(work, { effects, runTaskFn: noProvider })).toEqual(
      staged,
    );
    expect(provider).toHaveBeenCalledTimes(2);
  });

  // @invariant concurrency: original generation is mandatory after bootstrap and cannot be replaced at consumption
  // @fails-if the adapter reads current control to upgrade stale jobs or returns success over a rejected send claim
  it('fences the original generation against explicit control before any send', async () => {
    await seedDagRun();
    await seedQuestion('q_adapter_generation');
    await seedDispatchedNode({ ...request, dispatch: originalDispatch });
    await db
      .insert(paid_effect_control)
      .values({ family: ITEM_PRIOR_MEMBER, backend: 'pg-boss', generation: 2 });
    const provider = vi.fn(async () => ({ text: output(0.1) }));
    await expect(
      runItemPriorDurableMemberExecution({
        db,
        request: { ...request, dispatch: originalDispatch },
        steps: executionSteps().runner,
        runTaskFn: provider,
        gateEpoch: noGate,
      }),
    ).rejects.toMatchObject({
      name: 'PaidEffectControlFencedError',
      reason: 'stale_generation',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(await db.select().from(paid_effect)).toEqual([]);
    expect(await db.select().from(item_calibration)).toEqual([]);
    expect((await db.select().from(paid_effect_control))[0]?.generation).toBe(2);
  });

  // @invariant grading: LLaSA remains one paid unit with frozen reference/choices input and separate provenance
  // @fails-if requested reps multiply LLaSA calls, drop its reference input, or reuse feature receipts
  it('uses a single LLaSA unit with frozen reference input', async () => {
    await seedDagRun();
    await seedQuestion('q_adapter_llasa');
    const checkpoints = executionSteps();
    await seedDispatchedNode({ ...request, dispatch: originalDispatch, method: 'llasa', reps: 9 });
    const provider = vi.fn(async () => ({
      text: JSON.stringify({
        simulated_responses: [-2, -1, 0, 1, 2].flatMap((theta) =>
          [0, 1].map((student) => ({
            theta_level: theta,
            student_answer_md: `第${theta}档学生${student}分类与边界作答。`.repeat(20),
            correct: theta >= 0,
            note: theta >= 0 ? '关键边界完整' : '遗漏退化情形',
          })),
        ),
        reasoning: '按冻结参考答案判定模拟作答。',
      }),
    }));
    const result = await runItemPriorDurableMemberExecution({
      db,
      request: { ...request, dispatch: originalDispatch, method: 'llasa', reps: 9 },
      steps: checkpoints.runner,
      runTaskFn: provider,
      gateEpoch: noGate,
    });
    expect(result).toMatchObject({ matched: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    const [receipt] = await db.select().from(paid_effect);
    expect(receipt).toMatchObject({
      unit: 'llasa/rep:0',
      state: 'applied',
      input_json: {
        taskName: 'ItemPriorLlasaTask',
        input: { reference_md: '先讨论一般情况，再讨论退化情况。', choices_md: null },
      },
    });
    const [anchor] = await db.select().from(item_calibration);
    expect(anchor.source).toBe('llm_prior_llasa');
    // A readback alone cannot manufacture an application receipt or causal attribution.
    expect(await commitItemPriorStagedCalibration(db, result.items[0])).toEqual({
      status: 'matched',
    });
  });
});

describe('item prior noncausal application dispositions (DB, prepared)', () => {
  // @invariant durability: equality with an existing row never invents causal authorship and differing rows survive
  // @fails-if a foreign row is overwritten, bare readback marks paid effects applied, or receipt equality is skipped
  it('records matched and superseded dispositions atomically while preserving foreign rows', async () => {
    for (const [id, b] of [
      ['q_foreign_equal', 0.15],
      ['q_foreign_different', -0.6],
    ] as const) {
      await seedQuestion(id);
      const work = await realWork(id, 1);
      const effects = new ItemPriorPaidEffectAdapter(db, originalDispatch);
      const staged = await runItemPriorItemRepStages(work, {
        effects,
        runTaskFn: async () => ({ text: output(0.15) }),
      });
      await db.insert(item_calibration).values({
        id: createId(),
        question_id: id,
        track: 'hard',
        b,
        b_anchor: b,
        confidence: 1 / 3,
        source: 'llm_prior',
      });
      const before = await db
        .select()
        .from(item_calibration)
        .where(eq(item_calibration.question_id, id));
      const disposition = await commitItemPriorStagedCalibration(db, staged);
      expect(disposition.status).toBe(id === 'q_foreign_equal' ? 'matched' : 'superseded');
      expect((await readPaidEffect(db, effectIdentity(work)))?.state).toBe('receipt_ready');
      expect(await effects.commitStaged(work, staged)).toEqual(disposition);
      const applied = await readPaidEffect(db, effectIdentity(work));
      expect(applied).toMatchObject({ state: 'applied', application: { disposition } });
      expect(await effects.commitStaged(work, staged)).toEqual(disposition);
      expect(await readPaidEffect(db, effectIdentity(work))).toEqual(applied);
      expect(
        await db.select().from(item_calibration).where(eq(item_calibration.question_id, id)),
      ).toEqual(before);
    }
  });

  // @invariant durability: known parse failures need immutable application receipts but never a fabricated anchor
  // @fails-if no-anchor leaves receipt_ready forever or writes a default hard row
  it('settles no-anchor only with every immutable result and application receipt', async () => {
    await seedQuestion('q_no_anchor');
    const work = await realWork('q_no_anchor', 2);
    const effects = new ItemPriorPaidEffectAdapter(db, originalDispatch);
    const staged = await runItemPriorItemRepStages(work, {
      effects,
      runTaskFn: async () => ({ text: '{invalid structured response' }),
    });
    expect(staged.status).toBe('no-anchor');
    expect(await effects.commitStaged(work, staged)).toEqual({ status: 'no-anchor' });
    for (const rep of [0, 1]) {
      expect(await readPaidEffect(db, effectIdentity(work, rep))).toMatchObject({
        state: 'applied',
        application: { disposition: { status: 'no-anchor' }, draft: null },
      });
    }
    expect(await db.select().from(item_calibration)).toEqual([]);
  });
});

describe('adapter R1 recovery and owning delivery regressions (DB, prepared UNRUN)', () => {
  // @invariant durability: committed terminal application survives lost workflow acknowledgment and supported anchor changes
  // @fails-if replay recomputes superseded, conflicts forever, changes receipts, rewrites the fixed anchor, or sends again
  it('replays an applied historical matched receipt after lost acknowledgment and setFixedAnchor change', async () => {
    await seedDagRun();
    await seedQuestion('q_r1_anchor_recovery');
    const dispatched = await seedDispatchedNode({ ...request, dispatch: originalDispatch });
    const checkpoints = executionSteps();
    const outputs = [output(0.1), output(0.4), output(0.2)];
    const provider = vi.fn(async () => ({ text: outputs.shift() ?? '' }));
    await expect(
      runItemPriorDurableMemberExecution({
        db,
        request: dispatched,
        steps: checkpoints.runner,
        runTaskFn: provider,
        gateEpoch: noGate,
      }).then(() => {
        throw new Error('simulated lost workflow acknowledgment');
      }),
    ).rejects.toThrow('simulated lost workflow acknowledgment');
    const work = checkpoints.admission()?.prepared[0];
    if (!work) throw new Error('Missing frozen work');
    const paidBefore = await db.select().from(paid_effect);
    expect(paidBefore).toHaveLength(3);
    expect(paidBefore.every((r) => r.state === 'applied')).toBe(true);
    await setFixedAnchor(db, { questionId: work.candidate.id, bucket: 'very_hard' });
    const currentAnchor = await db.select().from(item_calibration);
    expect(currentAnchor[0]).toMatchObject({
      b: 2,
      b_anchor: 2,
      source: 'fixed_anchor',
      confidence: 1,
    });
    const stages = await runItemPriorItemRepStages(work, {
      effects: new ItemPriorPaidEffectAdapter(db, originalDispatch),
      runTaskFn: noProvider,
    });
    // Today's domain state is separate from the historical terminal application disposition.
    expect((await commitItemPriorStagedCalibration(db, stages)).status).toBe('superseded');
    const replayProvider = vi.fn(noProvider);
    const recovered = await runItemPriorDurableMemberExecution({
      db,
      request: dispatched,
      steps: checkpoints.runner,
      runTaskFn: replayProvider,
      gateEpoch: noGate,
    });
    expect(recovered).toMatchObject({ matched: 1, superseded: 0, held: 0, incomplete: 0 });
    expect(replayProvider).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(3);
    expect(await db.select().from(paid_effect)).toEqual(paidBefore);
    expect(await db.select().from(item_calibration)).toEqual(currentAnchor);
    expect((await db.select().from(dag_orchestration_node))[0]).toMatchObject({
      status: 'enqueued',
      boss_job_id: dispatched.dispatch.deliveryId,
    });
  });

  // @invariant durability: all-applied state alone is insufficient when immutable applications disagree with results or each other
  // @fails-if terminal replay trusts just state/applied/first receipt or repairs incompatible history through domain writes
  it('holds fully applied incompatible result or application payloads without rewriting history or domain', async () => {
    for (const mode of ['result', 'disposition'] as const) {
      const id = `q_r1_incompatible_${mode}`;
      await seedQuestion(id);
      const work = await realWork(id, 3);
      const effects = new ItemPriorPaidEffectAdapter(db, originalDispatch);
      const outputs = [output(0.1), output(0.4), output(0.2)];
      const staged = await runItemPriorItemRepStages(work, {
        effects,
        runTaskFn: async () => ({ text: outputs.shift() ?? '' }),
      });
      const results: Array<{ identity: ReturnType<typeof effectIdentity>; resultDigest: string }> =
        [];
      for (const rep of [0, 1, 2]) {
        const receipt = await readPaidEffect(db, effectIdentity(work, rep));
        if (receipt?.state !== 'receipt_ready') throw new Error('Missing real result receipt');
        results.push({
          identity: receipt.identity,
          resultDigest: computePaidEffectInputDigest(receipt.result),
        });
      }
      const application = {
        version: 1,
        questionId: id,
        questionRevision: work.questionRevision,
        inputDigest: work.inputDigest,
        method: work.method,
        repCount: 3,
        results,
        draft: staged.draft ?? null,
        disposition: { status: 'matched' },
      };
      await db.transaction(async (tx) => {
        for (const rep of [0, 1, 2]) {
          const incompatible =
            mode === 'result'
              ? {
                  ...application,
                  results: results.map((r) => ({
                    ...r,
                    resultDigest: computePaidEffectInputDigest('different immutable output'),
                  })),
                }
              : rep === 1
                ? {
                    ...application,
                    disposition: {
                      status: 'superseded',
                      existing: { b: -1, bAnchor: -1, confidence: 1, source: 'fixed_anchor' },
                    },
                  }
                : application;
          await recordPaidEffectApplication(tx, effectIdentity(work, rep), incompatible);
        }
      });
      const before = await db.select().from(paid_effect);
      expect(before.filter((r) => r.entity_id === id).every((r) => r.state === 'applied')).toBe(
        true,
      );
      await expect(effects.commitStaged(work, staged)).rejects.toMatchObject({
        code: 'ITEM_PRIOR_APPLICATION',
        reason: { name: 'PaidEffectApplicationConflictError' },
      });
      expect(await db.select().from(paid_effect)).toEqual(before);
      expect(await db.select().from(item_calibration)).toEqual([]);
      const replayProvider = vi.fn(noProvider);
      expect(await runItemPriorItemRepStages(work, { effects, runTaskFn: replayProvider })).toEqual(
        staged,
      );
      expect(replayProvider).not.toHaveBeenCalled();
    }
  });

  // @invariant concurrency: only the node-bound original active pg-boss delivery may bypass the competing-job guard
  // @fails-if the own active job is rejected, a foreign job/backend is admitted, or the old candidate's guard is weakened
  it('admits the exact original active owning job and rejects competing deliveries while keeping the old candidate held', async () => {
    await seedDagRun();
    await seedQuestion('q_r1_own_active');
    const dispatched = await seedDispatchedNode({ ...request, dispatch: originalDispatch });
    expect(
      await fixtureBoss?.getJobById(ITEM_PRIOR_MEMBER, dispatched.dispatch.deliveryId),
    ).toMatchObject({ id: dispatched.dispatch.deliveryId, state: 'active', data: dispatched });
    const competing = await createActiveDispatchedJob({
      ...dispatched,
      dispatch: { ...dispatched.dispatch, deliveryId: randomUUID() },
    });
    expect(
      await fixtureBoss?.getJobById(ITEM_PRIOR_MEMBER, competing.dispatch.deliveryId),
    ).toMatchObject({ id: competing.dispatch.deliveryId, state: 'active', data: competing });
    const noSend = vi.fn(noProvider);
    await expect(
      runItemPriorDurableMember({ db, request, steps: steps(), gateEpoch: noGate }),
    ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
    for (const foreign of [
      competing,
      { ...dispatched, dispatch: { ...dispatched.dispatch, backend: 'dbos' } },
    ]) {
      await expect(
        runItemPriorDurableMemberExecution({
          db,
          request: foreign,
          steps: executionSteps().runner,
          runTaskFn: noSend,
          gateEpoch: noGate,
        }),
      ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
    }
    expect(noSend).not.toHaveBeenCalled();
    expect(await db.select().from(paid_effect)).toEqual([]);
    const provider = vi.fn(async () => ({ text: output(0.2) }));
    const result = await runItemPriorDurableMemberExecution({
      db,
      request: dispatched,
      steps: executionSteps().runner,
      runTaskFn: provider,
      gateEpoch: noGate,
    });
    expect(result).toMatchObject({ matched: 1, considered: 1 });
    expect(provider).toHaveBeenCalledTimes(3);
    expect((await db.select().from(dag_orchestration_node))[0]).toMatchObject({
      status: 'enqueued',
      boss_job_id: dispatched.dispatch.deliveryId,
    });
  });

  // @invariant concurrency: declared backend/ID cannot upgrade an old job or substitute a foreign persisted payload/current generation
  // @fails-if node-bound ID and pg-boss declaration alone admit unversioned, wrong-node, wrong-queue or upgraded-generation jobs
  it('rejects unversioned, foreign identity, wrong queue and generation-substituted active job payloads', async () => {
    await seedDagRun();
    await seedQuestion('q_r1_foreign_payload');
    const provider = vi.fn(noProvider);
    const cases = ['unversioned', 'foreign-node', 'wrong-queue', 'upgraded-generation'] as const;
    for (const variant of cases) {
      const dispatched = {
        ...request,
        dispatch: { ...originalDispatch, deliveryId: randomUUID() },
      };
      const stored =
        variant === 'unversioned'
          ? {}
          : variant === 'foreign-node'
            ? { ...dispatched, nodeId: 'foreign_node' }
            : dispatched;
      await seedDispatchedNode(
        dispatched,
        stored,
        variant === 'wrong-queue' ? 'foreign_item_prior_queue' : ITEM_PRIOR_MEMBER,
      );
      if (variant === 'upgraded-generation') {
        await db
          .insert(paid_effect_control)
          .values({ family: ITEM_PRIOR_MEMBER, backend: 'pg-boss', generation: 1 });
      }
      const supplied =
        variant === 'upgraded-generation'
          ? { ...dispatched, dispatch: { ...dispatched.dispatch, generation: 1 } }
          : dispatched;
      await expect(
        runItemPriorDurableMemberExecution({
          db,
          request: supplied,
          steps: executionSteps().runner,
          runTaskFn: provider,
          gateEpoch: noGate,
        }),
      ).rejects.toBeInstanceOf(ItemPriorMemberIdentityError);
      expect(
        await fixtureBoss?.getJobById(
          variant === 'wrong-queue' ? 'foreign_item_prior_queue' : ITEM_PRIOR_MEMBER,
          dispatched.dispatch.deliveryId,
        ),
      ).toMatchObject({ state: 'active', data: stored });
      expect(await db.select().from(paid_effect)).toEqual([]);
      expect(await db.select().from(item_calibration)).toEqual([]);
    }
    expect(provider).not.toHaveBeenCalled();
  });
});
