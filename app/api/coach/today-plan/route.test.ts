import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit: mock the DB client + the reader so the route is exercised in isolation
// (the reader is DB-tested in src/server/today/coach-plan.test.ts).
vi.mock('@/db/client', () => ({ db: {} }));
const getLatestCoachPlan = vi.fn();
vi.mock('@/server/today/coach-plan', () => ({
  getLatestCoachPlan: (...args: unknown[]) => getLatestCoachPlan(...args),
}));

import { GET } from './route';

describe('GET /api/coach/today-plan', () => {
  beforeEach(() => {
    getLatestCoachPlan.mockReset();
  });

  it('returns the latest coach plan view', async () => {
    const view = {
      daily_plan: { daily_focus: '今日聚焦' },
      daily_ran_at: '2026-06-01T03:00:00.000Z',
      weekly_reflection: '本周复盘',
      weekly_ran_at: '2026-06-01T02:00:00.000Z',
    };
    getLatestCoachPlan.mockResolvedValue(view);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    // The route's only wiring contract: it passes the db client to the reader.
    expect(getLatestCoachPlan).toHaveBeenCalledTimes(1);
    expect(getLatestCoachPlan).toHaveBeenCalledWith({}); // the mocked @/db/client
  });

  it('maps a thrown error through errorResponse', async () => {
    getLatestCoachPlan.mockRejectedValue(new Error('db down'));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
