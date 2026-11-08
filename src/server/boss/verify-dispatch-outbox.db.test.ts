import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';

import {
  type EnqueueVerifyFn,
  VERIFY_DISPATCH_BOUND_ACTION,
  VERIFY_DISPATCH_COMPLETE_ACTION,
  dispatchPendingVerifyIntents,
  verifyDeliveryJobId,
  verifyDispatchBoundEventIdForIntent,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/question-bank/public';
import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { resetDb } from '../../../tests/helpers/db';

async function seedQuestion(
  id: string,
  source: 'quiz_gen' | 'web_sourced',
  over: Partial<typeof question.$inferInsert> = {},
) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: id,
    source,
    draft_status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
}

async function seedIntent(questionId: string, verifier: 'quiz_verify' | 'source_verify') {
  return writeVerifyDispatchIntent(db, { questionId, verifier });
}

async function snapshotDispatchState() {
  const events = await db.execute(sql`
    SELECT action, subject_id,
      payload->>'delivery_id' AS delivery_id,
      payload->'question_ids' AS question_ids,
      payload->>'disposition' AS disposition,
      payload->>'verifier_kind' AS verifier_kind
    FROM event
    WHERE action IN (
      'experimental:verify_dispatch_intent',
      'experimental:verify_dispatch_bound',
      'experimental:verify_dispatch')
    ORDER BY created_at, id`);
  const jobs = await db.execute(sql`
    SELECT id, state, data->'question_ids' AS question_ids
    FROM pgboss.job WHERE name = 'quiz_verify' ORDER BY created_on`);
  console.log('SNAPSHOT dispatch events:', JSON.stringify(events));
  console.log('SNAPSHOT pgboss jobs:', JSON.stringify(jobs));
}

describe('verify dispatch outbox (YUK-700)', () => {
  let realBoss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    _resetBossForTests();
    realBoss = createBoss();
    await realBoss.start();
    await realBoss.createQueue('quiz_verify');
  });

  afterAll(async () => {
    await realBoss.deleteAllJobs('quiz_verify');
    await realBoss.stop({ graceful: false, timeout: 1_000 });
    _resetBossForTests();
  });

  beforeEach(async () => {
    await resetDb();
    await realBoss.deleteAllJobs('quiz_verify');
  });

  // @invariant concurrency: racing drains bind disjoint batches (SKIP LOCKED may
  // split the locked page), and after the round plus one compensating pass — the
  // same call the poller makes — every intent is delivered exactly once, as one
  // engine job per bound batch
  // @fails-if the bound claim does not fence concurrent drains — a second
  // drain would mint a second paid verify for the same intent
  it('concurrent drains converge on one engine delivery per bound batch', async () => {
    onTestFailed(snapshotDispatchState);
    await Promise.all([seedQuestion('q-c1', 'quiz_gen'), seedQuestion('q-c2', 'quiz_gen')]);
    await Promise.all([seedIntent('q-c1', 'quiz_verify'), seedIntent('q-c2', 'quiz_verify')]);
    const enqueue: EnqueueVerifyFn = async (verifier, questionIds, options) => {
      await realBoss.send(verifier, { question_ids: questionIds }, options);
    };

    await Promise.all([
      dispatchPendingVerifyIntents(db, { enqueue }),
      dispatchPendingVerifyIntents(db, { enqueue }),
    ]);
    await dispatchPendingVerifyIntents(db, { enqueue });

    // One engine job per bound batch, carrying that batch's exact question set.
    const bounds = (await db
      .select({
        deliveryId: sql`${event.payload}->>'delivery_id'`,
        questionIds: sql`${event.payload}->'question_ids'`,
      })
      .from(event)
      .where(eq(event.action, VERIFY_DISPATCH_BOUND_ACTION))) as {
      deliveryId: string;
      questionIds: string[];
    }[];
    const boundByDelivery = new Map<string, string[]>();
    for (const row of bounds) {
      const memberSet = [...row.questionIds].sort();
      const existing = boundByDelivery.get(row.deliveryId);
      if (existing) {
        expect(existing).toEqual(memberSet);
      } else {
        boundByDelivery.set(row.deliveryId, memberSet);
      }
    }

    const jobs = (await db.execute(sql`
      SELECT id, state, data->'question_ids' AS question_ids
      FROM pgboss.job WHERE name = 'quiz_verify' ORDER BY created_on, id`)) as unknown as {
      id: string;
      state: string;
      question_ids: string[];
    }[];
    const liveJobs = jobs.filter((j) => j.state === 'created' || j.state === 'retry');
    expect(new Set(liveJobs.map((j) => j.id)).size).toBe(liveJobs.length);
    expect(liveJobs.map((j) => j.id).sort()).toEqual([...boundByDelivery.keys()].sort());
    for (const job of liveJobs) {
      expect([...job.question_ids].sort()).toEqual(boundByDelivery.get(job.id));
    }

    // Every intent delivered exactly once, and acked exactly once.
    const delivered = liveJobs.flatMap((j) => j.question_ids).sort();
    expect(delivered).toEqual(['q-c1', 'q-c2']);
    const completions = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
          inArray(event.subject_id, ['q-c1', 'q-c2']),
        ),
      );
    expect(completions).toHaveLength(2);
  });

  // @invariant concurrency: a bound-but-unacked intent is
  // re-driven under the identical stable delivery id, never a second job
  // @fails-if the crash window between bind/send/ack mints a fresh delivery
  // id — the engine would hold two paid verifies for one intent
  it.each([
    {
      scenario: 'bind committed but the send was rejected',
      engineAcceptedBefore: false,
    },
    {
      scenario: 'engine accepted the delivery but the ack was lost',
      engineAcceptedBefore: true,
    },
  ])('crash window — $scenario', async ({ engineAcceptedBefore }) => {
    await seedQuestion('q-x', 'quiz_gen');
    const intentId = await seedIntent('q-x', 'quiz_verify');
    const deliveryId = verifyDeliveryJobId('quiz_verify', [intentId]);

    if (engineAcceptedBefore) {
      // Engine already holds this exact delivery; bound row committed, ack lost.
      await realBoss.send('quiz_verify', { question_ids: ['q-x'] }, { id: deliveryId });
      const now = new Date();
      await writeEvent(db, {
        id: verifyDispatchBoundEventIdForIntent(intentId),
        actor_kind: 'system',
        actor_ref: 'verify_dispatch_outbox',
        action: VERIFY_DISPATCH_BOUND_ACTION,
        subject_kind: 'question',
        subject_id: 'q-x',
        outcome: 'success',
        payload: {
          version: 1,
          verifier_kind: 'quiz_verify',
          delivery_id: deliveryId,
          question_ids: ['q-x'],
          intent_ids: [intentId],
        },
        created_at: now,
        ingest_at: now,
      });
    } else {
      // Bind commits, then the send throws: bound rows survive, nothing landed.
      const rejecting: EnqueueVerifyFn = async () => {
        throw new Error('engine unreachable');
      };
      await dispatchPendingVerifyIntents(db, { enqueue: rejecting });
    }

    const sent: string[] = [];
    const enqueue: EnqueueVerifyFn = async (verifier, questionIds, options) => {
      const id = (options as { id?: string } | undefined)?.id;
      if (id) sent.push(id);
      await realBoss.send(verifier, { question_ids: questionIds }, options);
    };
    await dispatchPendingVerifyIntents(db, { enqueue });

    expect(sent).toEqual([deliveryId]);
    expect(await realBoss.fetch('quiz_verify')).toHaveLength(1);
    const completions = await db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION), eq(event.subject_id, 'q-x')));
    expect(completions.some((row) => row.id.startsWith('verify-dispatch-complete-'))).toBe(true);
  });
});
