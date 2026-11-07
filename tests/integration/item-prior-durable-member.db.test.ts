// Real Postgres admission checks, one-step double, no DBOS runtime or provider.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { itemPriorDispatchedRequestSchema } from '@/capabilities/practice/question-bank/public';
import {
  type ItemPriorPreparedWork,
  executeItemPriorRep,
  prepareItemPriorWork,
} from '@/capabilities/practice/question-bank/server/item-prior-durable-operation';
import {
  ItemPriorPaidEffectAdapter,
  itemPriorPaidEffectInput,
  itemPriorPaidEffectRevision,
} from '@/capabilities/practice/question-bank/server/item-prior-paid-effect-adapter';
import { readPaidEffect } from '@/core/paid-work/server/paid-effect-store';
import { paid_effect, question } from '@/db/schema';
import { resetDb, testDb } from '../helpers/db';

const ITEM_PRIOR_MEMBER = 'item_prior_backfill';
const db = testDb();
const request = {
  member: ITEM_PRIOR_MEMBER,
  dagRunId: 'run_itemprior_dbtest',
  nodeId: 'node_itemprior_dbtest',
  runDate: '2026-10-11',
};

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

beforeEach(async () => {
  await resetDb();
});

// Real-PG float4 check for the application seam (R1 P1). Real `real` columns,
// real applyItemPrior write, no provider, no DBOS runtime.

// Every case below uses the concrete adapter + fixed B store + real Postgres.
// The task runner is an offline output fixture.
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
    retryLimit: 0,
  });
  if (!jobId) throw new Error('Fixture job was not enqueued');
  ownedJobs.push({ name, id: jobId });
  const [job] = await fixtureBoss.fetch(name, { includeMetadata: true });
  if (job?.id !== jobId || job.state !== 'active')
    throw new Error('Fixture must fetch the exact job into active state');

  return dispatched;
}

async function activeEffects() {
  const dispatched = await createActiveDispatchedJob({
    ...request,
    dispatch: { ...originalDispatch, deliveryId: randomUUID() },
  });
  return new ItemPriorPaidEffectAdapter(db, dispatched);
}

afterEach(async () => {
  for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
});
afterAll(async () => {
  await fixtureBoss?.stop();
});

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

describe('item prior concrete shared-store consumer (DB)', () => {
  // @invariant concurrency: exactly one reservation wins and only its exact fence/delivery can persist output
  // @fails-if two reserve calls win, a stale fence completes, or a completed result is physically sent again
  it('reserves once under a real store race and completes only with the exact winning fence', async () => {
    await seedQuestion('q_adapter_race');
    const work = await realWork('q_adapter_race', 1);
    const a = await activeEffects();
    const b = await activeEffects();
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
});
