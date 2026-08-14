import type { Db } from '@/db/client';
import { knowledge, learning_item, practice_stream_item, question } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { handleReviewDue } from './due-list';

const DATES = Array.from({ length: 10 }, (_, index) => `2026-08-${10 + index}`);
const clients: Array<ReturnType<typeof postgres>> = [];
type GlobalWithDbPool = typeof globalThis & {
  __loomQueryClient?: ReturnType<typeof postgres>;
};
const globalForDb: GlobalWithDbPool = globalThis;

async function createMaxTenSingletonDb(
  statementTimeout = 750,
): Promise<{ db: Db; client: ReturnType<typeof postgres> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new TypeError('TEST_DATABASE_URL is required');
  const client = postgres(url, { max: 10, connection: { statement_timeout: statementTimeout } });
  clients.push(client);
  globalForDb.__loomQueryClient = client;
  vi.resetModules();
  const { db } = await import('@/db/client');
  return { db, client };
}

async function waitForAdvisoryWaiters(
  observer: ReturnType<typeof postgres>,
  expectedCount: number,
): Promise<void> {
  const deadlineAt = Date.now() + 5_000;
  for (;;) {
    const [waiting] = await observer<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    if (waiting.count >= expectedCount) return;
    if (Date.now() >= deadlineAt) {
      throw new Error(`Expected ${expectedCount} advisory waiters, observed ${waiting.count}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function seedSamplableQuestion(db: Db): Promise<string> {
  const now = new Date();
  const knowledgeId = createId();
  const questionId = createId();
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: 'reserved session ownership',
    domain: 'computer-science',
    created_at: now,
    updated_at: now,
  });
  await db.insert(learning_item).values({
    id: createId(),
    source: 'learning_intent',
    title: 'reserved session ownership',
    knowledge_ids: [knowledgeId],
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: 'Which session must own work guarded by a session advisory lock?',
    reference_md: 'The reserved lock-holding session.',
    knowledge_ids: [knowledgeId],
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
  });
  return questionId;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end({ timeout: 1 })));
  Reflect.deleteProperty(globalForDb, '__loomQueryClient');
  vi.resetModules();
});

const operations = [
  { kind: 'nightly', name: 'nightly composes' },
  { kind: 'recompose', name: 'explicit recomposes' },
] as const;

describe('Practice stream reserved connection integration', () => {
  it('runs due-list dependencies on the injected transaction backend', async () => {
    // Given an explicit transaction injected into the due-list handler.
    const { db } = await createMaxTenSingletonDb();
    let expectedBackendPid: number | undefined;
    let observedBackendPid: number | undefined;

    // When the handler reaches its goal reader after all earlier due-list reads.
    const response = await db.transaction(async (tx) => {
      const [expected] = await tx.execute(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`);
      expectedBackendPid = Number(expected.pid);
      return handleReviewDue(new Request('http://internal/api/review/due?limit=1'), {
        db: tx,
        listActiveGoalsFn: async (activeDb) => {
          const [observed] = await activeDb.execute(
            sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`,
          );
          observedBackendPid = Number(observed.pid);
          return [];
        },
      });
    });

    // Then downstream reads observe the same physical backend as the lock-holder transaction.
    expect(response.status).toBe(200);
    expect(observedBackendPid).toBe(expectedBackendPid);
  });

  it('keeps ten same-date reranks on their lock-holder transaction', async () => {
    // Given an external holder blocking all ten same-key reranks in a production-sized pool.
    const { db, client } = await createMaxTenSingletonDb(10_000);
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new TypeError('TEST_DATABASE_URL is required');
    const observer = postgres(url, { max: 1 });
    const holder = postgres(url, { max: 1 });
    clients.push(observer, holder);
    const { reRankAfterAnswer } = await import('./stream-store');
    const questionId = await seedSamplableQuestion(db);
    await db.insert(practice_stream_item).values({
      id: createId(),
      date: DATES[0],
      position: 1,
      item_kind: 'question',
      ref_id: questionId,
      source: 'new_check',
      status: 'pending',
      reasoning: 'rerank pool ownership probe',
      added_by: 'composer_live',
      signals: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    const holderAcquired = Promise.withResolvers<void>();
    const releaseHolder = Promise.withResolvers<void>();
    const holderTransaction = holder.begin(async (holderSql) => {
      await holderSql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${DATES[0]}`}))`;
      holderAcquired.resolve();
      await releaseHolder.promise;
    });
    await Promise.race([holderAcquired.promise, holderTransaction]);
    const inFlight = Array.from({ length: 10 }, () =>
      reRankAfterAnswer(db, { date: DATES[0], answeredQuestionId: questionId, rng: () => 0 }),
    );
    const settled = Promise.allSettled(inFlight);

    // When all ten target transactions are waiting, release the external transaction-level lock.
    try {
      await waitForAdvisoryWaiters(observer, 10);
    } finally {
      releaseHolder.resolve();
      await holderTransaction;
    }
    const completion = await Promise.race([
      Promise.race(inFlight).then(() => 'completed' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 2_000)),
    ]);
    if (completion === 'timed_out') await client.end({ timeout: 0 });
    const results = completion === 'completed' ? await settled : [];

    // Then every rerank stays live because collector reads share the lock-holder transaction.
    expect(completion).toBe('completed');
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it.each(operations)(
    'completes ten different-date $name on the production max-ten singleton pool',
    async ({ kind }) => {
      // Given ten independent paid-work keys whose operations pause at one provider barrier.
      const { db, client } = await createMaxTenSingletonDb();
      const { composeNightly, recomposeStream } = await import('./stream-store');
      const run = { nightly: composeNightly, recompose: recomposeStream }[kind];
      const questionId = await seedSamplableQuestion(db);
      const allOperationsEntered = Promise.withResolvers<void>();
      const releaseOperations = Promise.withResolvers<void>();
      let enteredCount = 0;
      const loadMemoryPrior = async () => {
        enteredCount += 1;
        if (enteredCount === DATES.length) allOperationsEntered.resolve();
        await releaseOperations.promise;
        return ['reserved connection owns locked work'];
      };
      const inFlight = DATES.map((date) =>
        run(db, date, {
          policy: { policy: 'softmax_mfi' },
          composeDeps: {
            loadMemoryPrior,
            runTaskFn: async () => ({
              text: JSON.stringify({
                candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: date }],
              }),
            }),
            rng: () => 0,
          },
        }),
      );
      const settled = Promise.allSettled(inFlight);

      // When every different-date operation must reach the barrier using only its reserved slot.
      const barrierOutcome = await Promise.race([
        allOperationsEntered.promise.then(() => 'all_entered' as const),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 2_000)),
      ]);
      releaseOperations.resolve();
      if (barrierOutcome === 'timed_out') await client.end({ timeout: 0 });
      const results = barrierOutcome === 'all_entered' ? await settled : [];

      // Then no operation self-starves by borrowing an eleventh connection for Drizzle work.
      expect(barrierOutcome).toBe('all_entered');
      expect(results).toEqual(DATES.map(() => ({ status: 'fulfilled' as const, value: 1 })));
    },
  );
});
