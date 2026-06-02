import { beforeEach, describe, expect, it } from 'vitest';

import type { TodayPlanT } from '@/core/schema/coach';
import { writeEvent } from '@/server/events/queries';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getLatestCoachPlan } from './coach-plan';

const db = testDb();

function plan(focus: string, extra: Partial<TodayPlanT> = {}): TodayPlanT {
  return {
    daily_focus: focus,
    review_session_proposal: { count: 5, estimated_minutes: 20 },
    plan_adjustments: [],
    maintenance_proposals: [],
    goal_ids: [],
    goal_strand: [],
    ...extra,
  };
}

async function writeCoachScan(opts: {
  id: string;
  runKind: 'daily' | 'weekly';
  todayPlan: TodayPlanT | null;
  at: Date;
  outcome?: 'success' | 'failure';
}): Promise<void> {
  await writeEvent(db, {
    id: opts.id,
    actor_kind: 'agent',
    actor_ref: 'coach',
    action: 'experimental:coach_scan',
    subject_kind: 'query',
    subject_id: opts.id,
    outcome: opts.outcome ?? 'success',
    payload: {
      run_kind: opts.runKind,
      ...(opts.todayPlan
        ? { today_plan: opts.todayPlan, daily_focus: opts.todayPlan.daily_focus }
        : { today_plan: null, plan_parse_error: true }),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.at,
  });
}

describe('getLatestCoachPlan', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns nulls when Coach has never run', async () => {
    const view = await getLatestCoachPlan(db);
    expect(view).toEqual({
      daily_plan: null,
      daily_ran_at: null,
      weekly_reflection: null,
      weekly_ran_at: null,
    });
  });

  it('returns the latest daily plan + the latest weekly reflection (partitioned by run_kind)', async () => {
    await writeCoachScan({
      id: 'd1',
      runKind: 'daily',
      todayPlan: plan('旧的每日聚焦'),
      at: new Date('2026-06-01T01:00:00Z'),
    });
    await writeCoachScan({
      id: 'w1',
      runKind: 'weekly',
      todayPlan: plan('周计划', { weekly_reflection: '本周复盘：虚词薄弱' }),
      at: new Date('2026-06-01T02:00:00Z'),
    });
    await writeCoachScan({
      id: 'd2',
      runKind: 'daily',
      todayPlan: plan('最新每日聚焦'),
      at: new Date('2026-06-01T03:00:00Z'),
    });

    const view = await getLatestCoachPlan(db);
    expect(view.daily_plan?.daily_focus).toBe('最新每日聚焦'); // newest daily, not d1
    expect(view.daily_ran_at).toBe(new Date('2026-06-01T03:00:00Z').toISOString());
    expect(view.weekly_reflection).toBe('本周复盘：虚词薄弱');
    expect(view.weekly_ran_at).toBe(new Date('2026-06-01T02:00:00Z').toISOString());
  });

  it('daily plan is null (parse error) but weekly still resolves independently', async () => {
    await writeCoachScan({
      id: 'd_bad',
      runKind: 'daily',
      todayPlan: null, // plan_parse_error
      at: new Date('2026-06-01T03:00:00Z'),
    });
    await writeCoachScan({
      id: 'w_ok',
      runKind: 'weekly',
      todayPlan: plan('周', { weekly_reflection: '复盘' }),
      at: new Date('2026-06-01T02:00:00Z'),
    });

    const view = await getLatestCoachPlan(db);
    expect(view.daily_plan).toBeNull();
    expect(view.daily_ran_at).toBe(new Date('2026-06-01T03:00:00Z').toISOString()); // ran, but plan unparseable
    expect(view.weekly_reflection).toBe('复盘');
  });

  it('weekly reflection is null (parse error) but weekly_ran_at still resolves', async () => {
    await writeCoachScan({
      id: 'w_bad',
      runKind: 'weekly',
      todayPlan: null, // plan_parse_error on the weekly run
      at: new Date('2026-06-01T02:00:00Z'),
    });
    await writeCoachScan({
      id: 'd_ok',
      runKind: 'daily',
      todayPlan: plan('今日'),
      at: new Date('2026-06-01T03:00:00Z'),
    });

    const view = await getLatestCoachPlan(db);
    expect(view.weekly_reflection).toBeNull();
    expect(view.weekly_ran_at).toBe(new Date('2026-06-01T02:00:00Z').toISOString()); // ran, plan unparseable
    expect(view.daily_plan?.daily_focus).toBe('今日');
  });
});
