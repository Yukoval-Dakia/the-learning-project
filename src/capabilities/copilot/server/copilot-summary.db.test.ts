// YUK-1578 — the /today copilot summary picks the newest coach run across
// success/degraded, so a parse-failure night never presents an older plan as
// current.

import { describe, expect, it } from 'vitest';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadCopilotSummary } from './copilot-summary';

async function seedCoachScan(input: {
  id: string;
  outcome: 'success' | 'degraded';
  at: Date;
  daily_focus: string;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: input.id,
    actor_kind: 'agent',
    actor_ref: 'coach',
    action: 'experimental:coach_scan',
    subject_kind: 'query',
    subject_id: `${input.id}_trigger`,
    outcome: input.outcome,
    payload:
      input.outcome === 'success'
        ? { today_plan: { daily_focus: input.daily_focus }, daily_focus: input.daily_focus }
        : { today_plan: null, plan_parse_error: true, degraded_reason: 'plan_parse_error' },
    created_at: input.at,
  });
}

describe('loadCopilotSummary newest coach run', () => {
  // @invariant data: the summary renders the newest coach run across success and degraded — a newer degraded run yields placeholder focus instead of the older plan, and a newer success still serves its plan
  // @fails-if the degraded candidate is excluded so the stale plan reads as current, or a degraded run outranks a newer success
  it.each([
    { name: 'newer degraded outranks older success', newest: 'degraded' as const },
    { name: 'newer success outranks older degraded', newest: 'success' as const },
  ])('$name', async ({ newest }) => {
    await resetDb();
    const older = new Date('2026-10-27T20:00:00Z');
    const newer = new Date('2026-10-27T21:00:00Z');
    await seedCoachScan({
      id: 'coach_scan_old',
      outcome: newest === 'degraded' ? 'success' : 'degraded',
      at: older,
      daily_focus: '旧计划焦点',
    });
    await seedCoachScan({
      id: 'coach_scan_new',
      outcome: newest,
      at: newer,
      daily_focus: '新计划焦点',
    });

    const summary = await loadCopilotSummary(testDb());
    expect(summary.coach_last_run_at).toBe(newer.toISOString());
    if (newest === 'degraded') {
      expect(summary.daily_focus).not.toBe('旧计划焦点');
    } else {
      expect(summary.daily_focus).toBe('新计划焦点');
    }
  });
});
