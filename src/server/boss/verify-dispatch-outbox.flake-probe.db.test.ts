// THROWAWAY diagnostic for the #2786 concurrent-drain flake — never committed.
// Widens the SKIP LOCKED interleave (8 intents × 3 drains) so the rare
// split the CI flake hit actually occurs, then asserts the product's real
// invariant: after the drains plus one compensating pass (the same function
// the poller calls), every intent is delivered exactly once.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type EnqueueVerifyFn,
  VERIFY_DISPATCH_BOUND_ACTION,
  VERIFY_DISPATCH_COMPLETE_ACTION,
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/question-bank/public';
import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { resetDb } from '../../../tests/helpers/db';

const QUESTION_COUNT = 8;
const DRAIN_COUNT = 3;
const RUNS = 30;

async function seedQuestion(id: string) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: id,
    source: 'quiz_gen',
    draft_status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
  });
}

async function jobRows() {
  const rows = (await db.execute(sql`
    SELECT id, state, data->'question_ids' AS question_ids
    FROM pgboss.job WHERE name = 'quiz_verify' ORDER BY created_on, id`)) as unknown as {
    id: string;
    state: string;
    question_ids: string[];
  }[];
  return rows;
}

describe('verify dispatch outbox flake probe', () => {
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

  it.each(Array.from({ length: RUNS }, (_, i) => i + 1))(
    'concurrent drains never lose an intent (probe run #%i)',
    async (run) => {
      const ids = Array.from({ length: QUESTION_COUNT }, (_, i) => `q-p${i + 1}`);
      await Promise.all(ids.map((id) => seedQuestion(id)));
      await Promise.all(
        ids.map((id) => writeVerifyDispatchIntent(db, { questionId: id, verifier: 'quiz_verify' })),
      );
      const enqueue: EnqueueVerifyFn = async (verifier, questionIds, options) => {
        await realBoss.send(verifier, { question_ids: questionIds }, options);
        await new Promise((resolve) => setTimeout(resolve, 20));
      };

      await Promise.all(
        Array.from({ length: DRAIN_COUNT }, () => dispatchPendingVerifyIntents(db, { enqueue })),
      );

      // Pre-compensation engine state (read-only query — fetch would consume).
      const preJobs = await jobRows();
      const preDelivered = preJobs.flatMap((j) => j.question_ids).sort();

      await dispatchPendingVerifyIntents(db, { enqueue });

      const bounds = await db
        .select({ deliveryId: sql<string>`${event.payload}->>'delivery_id'` })
        .from(event)
        .where(eq(event.action, VERIFY_DISPATCH_BOUND_ACTION));
      const boundDeliveryIds = new Set(bounds.map((b) => b.deliveryId));

      const postJobs = await jobRows();
      const liveJobs = postJobs.filter((j) => j.state === 'created' || j.state === 'retry');
      const postDelivered = liveJobs.flatMap((j) => j.question_ids).sort();
      const missing = ids.filter((id) => !postDelivered.includes(id));
      const dupes = ids.filter((id) => postDelivered.filter((d) => d === id).length > 1);
      const unacked = await db.execute(sql`
        SELECT i.subject_id FROM event i
        WHERE i.action = 'experimental:verify_dispatch_intent'
          AND NOT EXISTS (
            SELECT 1 FROM event c
            WHERE c.action = 'experimental:verify_dispatch'
              AND c.subject_id = i.subject_id)`);
      console.log(
        `PROBE run ${run}: pre_jobs=${preJobs.length} pre_delivered=${JSON.stringify(preDelivered)} ` +
          `post_live_jobs=${liveJobs.length} deliveries=${boundDeliveryIds.size} ` +
          `missing=${JSON.stringify(missing)} dupes=${JSON.stringify(dupes)} ` +
          `unacked=${(unacked as unknown as unknown[]).length}`,
      );

      expect(new Set(liveJobs.map((j) => j.id))).toEqual(boundDeliveryIds);
      expect(postDelivered).toEqual([...ids].sort());
      const completions = await db
        .select({ subjectId: event.subject_id })
        .from(event)
        .where(
          and(
            eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
            inArray(event.subject_id, ids),
          ),
        );
      expect(completions).toHaveLength(QUESTION_COUNT);
    },
  );
});
