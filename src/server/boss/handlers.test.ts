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
