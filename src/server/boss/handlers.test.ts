import type { Db } from '@/db/client';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { registerHandlers } from './handlers';

describe('registerHandlers', () => {
  it('registers and schedules knowledge_maintenance_nightly', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
    } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    expect(boss.createQueue).toHaveBeenCalledWith('knowledge_maintenance_nightly');
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

  // YUK-203 U4 / D5 — review_plan is chain-triggered (no schedule) and its
  // queue must be created BEFORE coach_daily so the worker is ready when
  // buildCoachDailyHandler chains the coach_daily → review_plan send.
  it('registers review_plan (no schedule) before coach_daily', async () => {
    const createQueue = vi.fn((_name: string) => Promise.resolve(undefined));
    const work = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const schedule = vi.fn((_name: string, ..._rest: unknown[]) => Promise.resolve(undefined));
    const boss = { createQueue, work, schedule } as unknown as PgBoss;

    await registerHandlers(boss, {} as Db);

    expect(createQueue).toHaveBeenCalledWith('review_plan');
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
