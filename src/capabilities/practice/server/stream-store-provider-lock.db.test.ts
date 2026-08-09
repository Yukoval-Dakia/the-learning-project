import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  knowledge,
  learning_item,
  practice_stream_item,
  provider_attempt,
  question,
} from '@/db/schema';
import {
  type Mem0OpaqueOperationContext,
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';
import { createId } from '@paralleldrive/cuid2';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { composeNightly, recomposeStream } from './stream-store';

const DATE = '2026-08-10';
const WAITER_BARRIER_TIMEOUT_MS = 5_000;
const clients: Array<ReturnType<typeof postgres>> = [];

function createTenConnectionDb(): { db: Db; client: ReturnType<typeof postgres> } {
  return createConnectionDb(10);
}

function createConnectionDb(max: number): { db: Db; client: ReturnType<typeof postgres> } {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new TypeError('TEST_DATABASE_URL is required');
  const client = postgres(url, {
    max,
    connection: { statement_timeout: 750 },
  });
  clients.push(client);
  return { db: drizzle(client, { schema }), client };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error) || !('code' in error)) return 'unknown_error';
  return typeof error.code === 'string' ? error.code : 'unknown_error';
}

function errorSqlState(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_sqlstate';
  if ('code' in error && typeof error.code === 'string') return error.code;
  return errorSqlState(error.cause);
}

async function waitForAdvisoryWaiters(
  observer: ReturnType<typeof postgres>,
  expectedCount: number,
): Promise<void> {
  const deadlineAt = Date.now() + WAITER_BARRIER_TIMEOUT_MS;
  for (;;) {
    const [waiting] = await observer<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
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
    name: '并发事务边界',
    domain: 'computer-science',
    created_at: now,
    updated_at: now,
  });
  await db.insert(learning_item).values({
    id: createId(),
    source: 'learning_intent',
    title: '并发事务边界',
    knowledge_ids: [knowledgeId],
    status: 'pending',
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: '哪一个事务边界不会让连接池自我饥饿？',
    reference_md: 'provider lifecycle 在 compose lock transaction 之外',
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
});

describe('Practice stream provider transaction boundary', () => {
  it('binds the default Mem0 loader to the paid-lock reserved session', async () => {
    // Given the production memory seam paused after reading its injected database backend.
    const { db, client } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let providerBackendPid: number | undefined;
    const readMemoryFacts = vi.fn(
      async (_query: string, _opts: unknown, providerOperation: Mem0OpaqueOperationContext) => {
        if (!providerOperation.db) throw new TypeError('Expected provider operation database');
        const [backend] = await providerOperation.db.$client<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `;
        providerBackendPid = backend.pid;
        entered.resolve();
        await release.promise;
        return { results: [] };
      },
    );
    vi.doMock('@/server/memory/read', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/server/memory/read')>()),
      readMemoryFacts,
    }));
    const compose = composeNightly(db, DATE, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: {
        providerInvocation: {
          db,
          caller: 'worker',
          deadlineAt: new Date(Date.now() + WAITER_BARRIER_TIMEOUT_MS),
          operationAnchor: 'practice-default-memory-reserved-session',
        },
        runTaskFn: async () => ({
          text: JSON.stringify({
            candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: 'binding' }],
          }),
        }),
        rng: () => 0,
      },
    });

    // When memory loading is active, inspect the backend holding the paid advisory key.
    let enteredTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) => {
          enteredTimeout = setTimeout(
            () => reject(new Error('Default memory loader did not reach the reserved session')),
            WAITER_BARRIER_TIMEOUT_MS,
          );
        }),
      ]);
      const [holder] = await client<{ pid: number }[]>`
        SELECT activity.pid
        FROM pg_locks held
        JOIN pg_stat_activity activity ON activity.pid = held.pid
        WHERE held.locktype = 'advisory'
          AND held.granted
          AND held.classid = 0
          AND held.objid = ((hashtext(${`stream:compose-paid:${DATE}`})::bigint & 4294967295)::oid)
          AND held.objsubid = 1
      `;

      // Then provider context and advisory ownership are the same physical session.
      expect(providerBackendPid).toBe(holder.pid);
      expect(readMemoryFacts).toHaveBeenCalledTimes(1);
    } finally {
      if (enteredTimeout !== undefined) clearTimeout(enteredTimeout);
      release.resolve();
      vi.doUnmock('@/server/memory/read');
    }
    await compose;
  });

  it('keeps a top-level provider transaction outside ten concurrent compose lock transactions', async () => {
    // Given a max=10 pool, one samplable candidate, and a loader that needs another transaction.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const loadMemoryPrior = vi.fn(() =>
      db.transaction(async (tx) => {
        await tx.select({ id: question.id }).from(question).limit(1);
        return ['事务边界必须隔离'];
      }),
    );
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: '事务边界清晰' }],
      }),
    }));

    // When ten same-date compose invocations contend for the paid-work single-flight boundary.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        composeNightly(db, DATE, {
          policy: { policy: 'softmax_mfi' },
          composeDeps: { loadMemoryPrior, runTaskFn, rng: () => 0 },
        }),
      ),
    );

    // Then one winner performs provider work and materialization without pool starvation.
    expect(results.reduce((sum, added) => sum + added, 0)).toBe(1);
    expect(loadMemoryPrior).toHaveBeenCalledTimes(1);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('holds the paid-work session lock without an open transaction at the provider barrier', async () => {
    // Given a compose whose loader pauses after observing its reserved backend.
    const { db, client } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const loadMemoryPrior = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return ['provider barrier'];
    });
    const compose = composeNightly(db, DATE, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: {
        loadMemoryPrior,
        runTaskFn: async () => ({
          text: JSON.stringify({
            candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: 'barrier' }],
          }),
        }),
        rng: () => 0,
      },
    });

    // When the provider barrier is active, inspect the exact reserved backend from another session.
    await entered.promise;
    const [activity] = await client<{ xact_start: Date | null }[]>`
      SELECT activity.xact_start
      FROM pg_locks held
      JOIN pg_stat_activity activity ON activity.pid = held.pid
      WHERE held.locktype = 'advisory'
        AND held.granted
        AND held.classid = 0
        AND held.objid = ((hashtext(${`stream:compose-paid:${DATE}`})::bigint & 4294967295)::oid)
        AND held.objsubid = 1
    `;

    // Then the paid key is held without a transaction while the original xact key remains free.
    try {
      expect(activity?.xact_start).toBeNull();
      await expect(
        client.begin((tx) =>
          tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [`stream:compose:${DATE}`]),
        ),
      ).resolves.toBeDefined();
    } finally {
      release.resolve();
    }
    await expect(compose).resolves.toBe(1);
    await expect(
      client.begin((tx) =>
        tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [`stream:compose:${DATE}`]),
      ),
    ).resolves.toBeDefined();
  });

  it('serializes ten explicit recomposes without nesting provider work under the materialization transaction', async () => {
    // Given a max=10 pool and a pre-existing pending row for an explicit recompose.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    await db.insert(practice_stream_item).values({
      id: createId(),
      date: DATE,
      position: 1,
      item_kind: 'question',
      ref_id: questionId,
      source: 'new_check',
      status: 'pending',
      reasoning: '旧计划',
      added_by: 'composer_live',
      signals: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    const loadMemoryPrior = vi.fn(async () =>
      db.transaction(async (tx) => {
        await tx.select({ id: question.id }).from(question).limit(1);
        return ['显式重排事务边界'];
      }),
    );
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: '显式重排' }],
      }),
    }));

    // When ten user-requested recomposes contend for the same date.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        recomposeStream(db, DATE, {
          policy: { policy: 'softmax_mfi' },
          composeDeps: { loadMemoryPrior, runTaskFn, rng: () => 0 },
        }),
      ),
    );

    // Then every explicit request runs once, but no request self-starves the pool.
    expect(results).toEqual(Array.from({ length: 10 }, () => 1));
    expect(loadMemoryPrior).toHaveBeenCalledTimes(10);
    expect(runTaskFn).toHaveBeenCalledTimes(10);
  });

  it('preserves a pending intervention inserted after recompose preparation', async () => {
    // Given recompose paused after its pending-id probe and plan preparation begins.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    await db.insert(practice_stream_item).values({
      id: createId(),
      date: DATE,
      position: 1,
      item_kind: 'question',
      ref_id: questionId,
      source: 'new_check',
      status: 'pending',
      reasoning: 'captured pending',
      added_by: 'composer_live',
      signals: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recompose = recomposeStream(db, DATE, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: {
        loadMemoryPrior: async () => {
          entered.resolve();
          await release.promise;
          return [];
        },
        runTaskFn: async () => ({
          text: JSON.stringify({
            candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: 'snapshot' }],
          }),
        }),
        rng: () => 0,
      },
    });
    await entered.promise;
    const interventionId = createId();
    await db.insert(practice_stream_item).values({
      id: interventionId,
      date: DATE,
      position: 2,
      item_kind: 'question',
      ref_id: createId(),
      source: 'intervention',
      status: 'pending',
      reasoning: 'approved during preparation',
      added_by: 'copilot',
      signals: {},
      created_at: new Date(),
      updated_at: new Date(),
    });

    // When finalization deletes only the pending ids captured by the probe transaction.
    release.resolve();
    await recompose;

    // Then the newly delivered intervention survives recompose finalization.
    const rows = await db.select().from(practice_stream_item);
    expect(rows.some((row) => row.id === interventionId && row.status === 'pending')).toBe(true);
  });

  it('passes the worker absolute deadline into the LLM runTask context', async () => {
    // Given one worker-owned compose invocation with an absolute provider deadline.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const deadlineAt = new Date(Date.now() + 5_000);
    const runTaskFn = vi.fn(
      async (_kind: string, _input: unknown, _ctx?: { providerSessionDeadlineAt?: number }) => ({
        text: JSON.stringify({
          candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: 'deadline' }],
        }),
      }),
    );

    // When L2 orchestration invokes the worker's task runner.
    await composeNightly(db, DATE, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: {
        loadMemoryPrior: async () => [],
        runTaskFn,
        providerInvocation: {
          db,
          caller: 'worker',
          deadlineAt,
          operationAnchor: 'practice-worker-llm-deadline',
        },
        rng: () => 0,
      },
    });

    // Then LLM admission receives the exact same absolute deadline as Mem0 and the paid lock.
    expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
      providerSessionDeadlineAt: deadlineAt.getTime(),
    });
  });

  it('times out a max-one reserve wait and releases the late connection', async () => {
    // Given the only pool connection held past a short caller deadline.
    const { db } = createConnectionDb(1);
    const held = await db.$client.reserve();
    const compose = composeNightly(db, DATE, {
      policy: { policy: 'legacy' },
      composeDeps: {
        providerInvocation: {
          db,
          caller: 'worker',
          deadlineAt: new Date(Date.now() + 100),
          operationAnchor: 'practice-max-one-reserve-deadline',
        },
      },
    });

    // When reserve cannot complete before the deadline, compose rejects without owning a client.
    const earlyOutcome = await Promise.race([
      compose.then(
        () => 'fulfilled' as const,
        (error: unknown) => errorCode(error),
      ),
      new Promise<'still_waiting'>((resolve) => setTimeout(() => resolve('still_waiting'), 250)),
    ]);
    held.release();
    await compose.catch(() => undefined);

    // Then the request is retryable and the eventual late reservation is automatically released.
    expect(earlyOutcome).toBe('practice_compose_busy');
    const probe = await Promise.race([
      db.$client.reserve(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(probe).not.toBeNull();
    probe?.release();
  });

  it('cleans up a paid lock acquired by a query that settles after its deadline', async () => {
    // Given a max-one pool whose try-lock acquires the real session lock before delaying its reply.
    const { db, client } = createConnectionDb(1);
    const external = createConnectionDb(1).client;
    await client.unsafe(`
      CREATE FUNCTION public.pg_try_advisory_lock(bigint) RETURNS boolean AS $$
      DECLARE acquired boolean;
      BEGIN
        acquired := pg_catalog.pg_try_advisory_lock($1);
        PERFORM pg_catalog.pg_sleep(0.3);
        RETURN acquired;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.unsafe('SET search_path TO public, pg_catalog');
    const startedAt = Date.now();

    // When the caller deadline wins while the delayed try-lock query may already own the key.
    try {
      const error = await composeNightly(db, DATE, {
        policy: { policy: 'legacy' },
        composeDeps: {
          providerInvocation: {
            db,
            caller: 'worker',
            deadlineAt: new Date(Date.now() + 100),
            operationAnchor: 'practice-delayed-try-lock-cleanup',
          },
        },
      }).catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('practice_compose_busy');
      expect(Date.now() - startedAt).toBeLessThan(250);
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Then cleanup releases both the exact paid key and the original pool slot.
      const [probe] = await external<{ acquired: boolean }[]>`
        SELECT pg_catalog.pg_try_advisory_lock(hashtext(${`stream:compose-paid:${DATE}`})) AS acquired
      `;
      expect(probe.acquired).toBe(true);
      await external.unsafe('SELECT pg_catalog.pg_advisory_unlock(hashtext($1))', [
        `stream:compose-paid:${DATE}`,
      ]);
      const poolSlot = await Promise.race([
        db.$client.reserve(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      expect(poolSlot).not.toBeNull();
      poolSlot?.release();
    } finally {
      await client.unsafe('SELECT pg_catalog.pg_advisory_unlock_all()');
      await client.unsafe('DROP FUNCTION IF EXISTS public.pg_try_advisory_lock(bigint)');
    }
  });

  it('keeps a terminal provider attempt when the later materialization transaction fails', async () => {
    // Given provider work that settles durably before a forced stream insert failure.
    const { db, client } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    await client.unsafe(`
      CREATE FUNCTION fail_practice_stream_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced materialization failure'; END;
      $$ LANGUAGE plpgsql
    `);
    await client.unsafe(`
      CREATE TRIGGER fail_practice_stream_insert
      BEFORE INSERT ON practice_stream_item
      FOR EACH ROW EXECUTE FUNCTION fail_practice_stream_insert()
    `);
    const operationAnchor = 'practice-compose-materialization-failure';
    const loadMemoryPrior = async () =>
      executeMem0OpaqueOperation(
        createMem0OpaqueOperationContext({
          db,
          caller: 'worker',
          deadlineAt: new Date(Date.now() + 65_000),
          operationAnchor,
        }),
        'search',
        async () => ['durable prior'],
      );

    // When provider settlement succeeds but the final compose transaction rolls back.
    try {
      const materializationError = await composeNightly(db, DATE, {
        policy: { policy: 'softmax_mfi' },
        composeDeps: {
          loadMemoryPrior,
          runTaskFn: async () => ({
            text: JSON.stringify({
              candidates: [
                { refId: questionId, weight: 1, role: 'new_check', reason: 'durability' },
              ],
            }),
          }),
          rng: () => 0,
        },
      }).catch((error: unknown) => error);
      expect(errorSqlState(materializationError)).toBe('P0001');
    } finally {
      await client.unsafe(
        'DROP TRIGGER IF EXISTS fail_practice_stream_insert ON practice_stream_item',
      );
      await client.unsafe('DROP FUNCTION IF EXISTS fail_practice_stream_insert()');
    }

    // Then the opaque attempt remains terminal and the stream insert remains rolled back.
    const attempts = await db.select().from(provider_attempt);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_kind: 'opaque_operation',
      operation_kind: 'search',
      terminal_status: 'succeeded',
    });
    expect(attempts[0].finished_at).toBeInstanceOf(Date);
    expect(await db.select().from(practice_stream_item)).toHaveLength(0);
    const lockProbe = await db.$client.reserve();
    try {
      const [probe] = await lockProbe<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${`stream:compose:${DATE}`})) AS acquired
      `;
      expect(probe.acquired).toBe(true);
      await lockProbe.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [`stream:compose:${DATE}`]);
    } finally {
      lockProbe.release();
    }
  });

  it('does not invoke provider or LLM work when there is no samplable candidate', async () => {
    // Given an empty candidate pool with injected paid-work seams.
    const { db } = createTenConnectionDb();
    const loadMemoryPrior = vi.fn(async () => ['must not load']);
    const runTaskFn = vi.fn(async () => ({ text: '{}' }));

    // When nightly compose prepares an empty plan.
    const added = await composeNightly(db, DATE, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { loadMemoryPrior, runTaskFn },
    });

    // Then no provider or LLM call is fabricated.
    expect(added).toBe(0);
    expect(loadMemoryPrior).not.toHaveBeenCalled();
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns a retryable error when the caller deadline expires behind a cross-process holder', async () => {
    // Given another process-equivalent session already holding the compose key.
    const { db } = createTenConnectionDb();
    const questionId = await seedSamplableQuestion(db);
    const holder = await db.$client.reserve();
    await holder.unsafe('SELECT pg_advisory_lock(hashtext($1))', [`stream:compose-paid:${DATE}`]);
    const loadMemoryPrior = vi.fn(async () => ['must not load']);

    // When the caller's provider deadline expires while non-blocking lock attempts back off.
    try {
      await expect(
        composeNightly(db, DATE, {
          policy: { policy: 'softmax_mfi' },
          composeDeps: {
            loadMemoryPrior,
            providerInvocation: {
              db,
              caller: 'worker',
              deadlineAt: new Date(Date.now() + 100),
              operationAnchor: 'practice-lock-deadline',
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'practice_compose_busy', status: 503 });
    } finally {
      await holder.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [
        `stream:compose-paid:${DATE}`,
      ]);
      holder.release();
    }

    // Then no paid provider work starts and the request remains explicitly retryable.
    expect(loadMemoryPrior).not.toHaveBeenCalled();
    await expect(
      composeNightly(db, DATE, {
        policy: { policy: 'softmax_mfi' },
        composeDeps: {
          loadMemoryPrior,
          runTaskFn: async () => ({
            text: JSON.stringify({
              candidates: [{ refId: questionId, weight: 1, role: 'new_check', reason: 'retry' }],
            }),
          }),
          rng: () => 0,
        },
      }),
    ).resolves.toBe(1);
    expect(loadMemoryPrior).toHaveBeenCalledTimes(1);
  });
});
