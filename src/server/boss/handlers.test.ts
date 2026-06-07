import type { Db } from '@/db/client';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { registerHandlers } from './handlers';

describe('registerHandlers', () => {
  it('registers and schedules knowledge_maintenance_nightly with expiry + DLQ (YUK-237)', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
    } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    // YUK-237: AGENT-tier queue — explicit 2h expire, 7-day retention, dead-letter.
    expect(boss.createQueue).toHaveBeenCalledWith('knowledge_maintenance_nightly', {
      expireInSeconds: 7_200,
      retentionSeconds: 604_800,
      deadLetter: 'knowledge_maintenance_nightly_dlq',
    });
    // YUK-237 (CODEX-2 round-2): createQueue is ON CONFLICT DO NOTHING, so an
    // already-existing queue keeps stale config on upgrade. We reconcile via
    // updateQueue right after, with the SAME opts, so the tuning lands on
    // pre-existing prod queues too.
    expect(boss.updateQueue).toHaveBeenCalledWith('knowledge_maintenance_nightly', {
      expireInSeconds: 7_200,
      retentionSeconds: 604_800,
      deadLetter: 'knowledge_maintenance_nightly_dlq',
    });
    // Its dead-letter queue is created first (FAST opts, no nested deadLetter).
    expect(boss.createQueue).toHaveBeenCalledWith('knowledge_maintenance_nightly_dlq', {
      expireInSeconds: 3_600,
      retentionSeconds: 604_800,
    });
    expect(boss.work).toHaveBeenCalledWith(
      'knowledge_maintenance_nightly',
      { pollingIntervalSeconds: 2, batchSize: 1 },
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      'knowledge_maintenance_nightly',
      '0 3 * * *',
      {},
      { tz: 'Asia/Shanghai' },
    );
  });

  // YUK-237: every LLM/agent producer queue gets a non-default active expiry
  // (the pg-boss default is 900s, which truncated long tool-calling jobs) and a
  // 7-day retention floor. FAST housekeeping queues get expiry+retention but no
  // dead-letter. Assert the invariants hold across ALL createQueue calls rather
  // than queue-by-queue.
  it('sets expireInSeconds >= 3600 and retentionSeconds 7d on every queue (YUK-237)', async () => {
    const createQueue = vi.fn((_name: string, _opts?: unknown) => Promise.resolve(undefined));
    const updateQueue = vi.fn((_name: string, _opts?: unknown) => Promise.resolve(undefined));
    const boss = {
      createQueue,
      updateQueue,
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
    } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    // The `memory_*` queues are registered by registerMemoryHandlers (the memory
    // module, NOT this file) and intentionally excluded — their expire/retention
    // tuning is tracked separately. Assert the invariant only on the queues this
    // file owns.
    const ownedCalls = createQueue.mock.calls.filter(
      ([name]) => !(name as string).startsWith('memory_'),
    );
    for (const [name, opts] of ownedCalls) {
      expect(opts, `queue ${name} must carry createQueue options`).toBeDefined();
      const o = opts as { expireInSeconds?: number; retentionSeconds?: number };
      expect(o.expireInSeconds, `queue ${name} expireInSeconds`).toBeGreaterThanOrEqual(3_600);
      expect(o.retentionSeconds, `queue ${name} retentionSeconds`).toBe(604_800);
    }

    // Dead-letter queues are created (one per LLM/agent producer) and each DLQ
    // is itself created BEFORE the queue that references it.
    const created = ownedCalls.map((c) => c[0] as string);
    const dlqNames = created.filter((n) => n.endsWith('_dlq'));
    expect(dlqNames.length).toBeGreaterThan(0);
    for (const dlq of dlqNames) {
      const parent = dlq.replace(/_dlq$/, '');
      expect(created).toContain(parent);
      expect(created.indexOf(dlq)).toBeLessThan(created.indexOf(parent));
    }

    // YUK-237 (CODEX-2 round-2): every owned queue is also reconciled via
    // updateQueue with the SAME opts (createQueue is ON CONFLICT DO NOTHING, so
    // an already-existing queue would otherwise keep stale config on upgrade).
    const updatedCalls = updateQueue.mock.calls.filter(
      ([name]) => !(name as string).startsWith('memory_'),
    );
    const updated = updatedCalls.map((c) => c[0] as string);
    for (const name of created) {
      expect(updated, `queue ${name} must be reconciled via updateQueue`).toContain(name);
    }
    // updateQueue opts mirror createQueue opts (same object reference path).
    for (const [name, opts] of updatedCalls) {
      const o = opts as { expireInSeconds?: number; retentionSeconds?: number };
      expect(o.expireInSeconds, `updateQueue ${name} expireInSeconds`).toBeGreaterThanOrEqual(
        3_600,
      );
      expect(o.retentionSeconds, `updateQueue ${name} retentionSeconds`).toBe(604_800);
    }
  });

  // YUK-203 U4 / D5 — review_plan is chain-triggered (no schedule) and its
  // queue must be created BEFORE coach_daily so the worker is ready when
  // buildCoachDailyHandler chains the coach_daily → review_plan send.
  it('registers review_plan (no schedule) before coach_daily', async () => {
    const createQueue = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const updateQueue = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const work = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const schedule = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const boss = { createQueue, updateQueue, work, schedule } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    // YUK-237: review_plan is now created with explicit LLM-tier opts + DLQ.
    expect(createQueue).toHaveBeenCalledWith('review_plan', {
      expireInSeconds: 3_600,
      retentionSeconds: 604_800,
      deadLetter: 'review_plan_dlq',
    });
    expect(work).toHaveBeenCalledWith(
      'review_plan',
      { pollingIntervalSeconds: 2, batchSize: 1 },
      expect.any(Function),
    );
    // Chain-triggered, NOT a cron (D5:29) — never scheduled.
    const scheduledQueues = schedule.mock.calls.map((c) => c[0]);
    expect(scheduledQueues).not.toContain('review_plan');

    // Ordering: review_plan createQueue must precede coach_daily createQueue.
    const createdQueues = createQueue.mock.calls.map((c) => c[0]);
    const reviewPlanIdx = createdQueues.indexOf('review_plan');
    const coachDailyIdx = createdQueues.indexOf('coach_daily');
    expect(reviewPlanIdx).toBeGreaterThanOrEqual(0);
    expect(coachDailyIdx).toBeGreaterThanOrEqual(0);
    expect(reviewPlanIdx).toBeLessThan(coachDailyIdx);
  });
});

// YUK-259 — createOrUpdateQueue concurrency safety. In a cold start the app's
// in-process boss (instrumentation) and the worker both register queues against
// the same DB; pg-boss's create_queue INSERT can race past its own ON CONFLICT
// and raise a 23505 `queue_pkey` violation, which previously crashed the worker
// mid-registration. The fix swallows that benign race and STILL reconciles the
// queue config via updateQueue (#329 semantics preserved).
describe('registerHandlers — concurrent create race (YUK-259)', () => {
  // Mimic the raw node-postgres error pg-boss raises (pg.Pool → `.code`/`.detail`
  // /`.constraint` live directly on the thrown object — no Drizzle wrapper).
  function pgDuplicateQueueError(queueName: string): Error {
    const err = new Error(`duplicate key value violates unique constraint "queue_pkey"`);
    Object.assign(err, {
      code: '23505',
      constraint: 'queue_pkey',
      schema: 'pgboss',
      table: 'queue',
      detail: `Key (name)=(${queueName}) already exists.`,
    });
    return err;
  }

  it('does NOT throw when createQueue raises 23505 queue_pkey, and still reconciles via updateQueue', async () => {
    // createQueue rejects with the duplicate-key race for EVERY queue, as if a
    // second process already inserted every row. Registration must still resolve.
    const createQueue = vi.fn((name: string) => Promise.reject(pgDuplicateQueueError(name)));
    const updateQueue = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const work = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const schedule = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const boss = { createQueue, updateQueue, work, schedule } as unknown as PgBoss;

    // The whole point of the fix: this must not reject.
    await expect(registerHandlers(boss, {} as Db)).resolves.toBeUndefined();

    // Despite every createQueue failing with the benign race, updateQueue still
    // runs for each owned queue so the YUK-237 config lands on the existing rows.
    const reconciled = updateQueue.mock.calls
      .map((c) => c[0] as string)
      .filter((n) => !n.startsWith('memory_'));
    expect(reconciled).toContain('knowledge_maintenance_nightly');
    expect(reconciled).toContain('review_plan');
    // A representative DLQ is reconciled too (created via createJobQueue).
    expect(reconciled).toContain('review_plan_dlq');
    // Work + schedule wiring is unaffected by the create race.
    expect(work).toHaveBeenCalledWith(
      'review_plan',
      { pollingIntervalSeconds: 2, batchSize: 1 },
      expect.any(Function),
    );
  });

  it('re-throws a non-23505 createQueue error (does not swallow real failures)', async () => {
    const fatal = new Error('connection terminated unexpectedly');
    Object.assign(fatal, { code: '08006' }); // connection_failure, NOT a create race
    const createQueue = vi.fn(() => Promise.reject(fatal));
    const updateQueue = vi.fn(() => Promise.resolve(undefined));
    const work = vi.fn(() => Promise.resolve(undefined));
    const schedule = vi.fn(() => Promise.resolve(undefined));
    const boss = { createQueue, updateQueue, work, schedule } as unknown as PgBoss;

    await expect(registerHandlers(boss, {} as Db)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });

  it('two concurrent registrations both resolve (trigger ①+② — app-boss + worker cold start / warm race)', async () => {
    // Shared, serialized queue store so the second registration sees the first's
    // rows as already-existing → its createQueue rejects with the 23505 race,
    // exactly like two processes hitting one DB. Both registrations must resolve.
    const existing = new Set<string>();
    const makeBoss = () => {
      const createQueue = vi.fn(async (name: string) => {
        if (existing.has(name)) throw pgDuplicateQueueError(name);
        existing.add(name);
        return undefined;
      });
      const updateQueue = vi.fn(async () => undefined);
      const work = vi.fn(async () => undefined);
      const schedule = vi.fn(async () => undefined);
      return { createQueue, updateQueue, work, schedule } as unknown as PgBoss;
    };

    const results = await Promise.allSettled([
      registerHandlers(makeBoss(), {} as Db),
      registerHandlers(makeBoss(), {} as Db),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('repeated same-process registration is idempotent (trigger ③ — next dev HMR re-evaluates the boss module)', async () => {
    // `next dev` HMR re-evaluates the instrumentation/boss module on every
    // recompile, so the SAME in-app boss re-runs createOrUpdateQueue for every
    // queue (owner observed 156× queue_pkey 23505 across 207 recompiles). After
    // the first registration the rows exist, so subsequent createQueue calls in
    // the SAME process raise the benign 23505 — registration must stay
    // idempotent (resolve, not throw) and keep reconciling config via
    // updateQueue. This asserts in-process idempotency, not just cross-process
    // safety.
    const existing = new Set<string>();
    const createQueue = vi.fn(async (name: string, ..._rest: unknown[]) => {
      if (existing.has(name)) throw pgDuplicateQueueError(name);
      existing.add(name);
      return undefined;
    });
    const updateQueue = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const work = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const schedule = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const boss = { createQueue, updateQueue, work, schedule } as unknown as PgBoss;

    // First registration seeds the rows; the next two simulate HMR recompiles
    // re-running registration against the now-warm queue table.
    await expect(registerHandlers(boss, {} as Db)).resolves.toBeUndefined();
    await expect(registerHandlers(boss, {} as Db)).resolves.toBeUndefined();
    await expect(registerHandlers(boss, {} as Db)).resolves.toBeUndefined();

    // updateQueue keeps running on every pass so config stays reconciled even
    // when createQueue is a no-op/raise on the warm table.
    const reconciled = updateQueue.mock.calls.map((c) => c[0] as string);
    expect(reconciled).toContain('review_plan');
  });
});
