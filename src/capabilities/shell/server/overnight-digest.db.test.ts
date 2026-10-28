// YUK-1578 — a degraded scan event surfaces in the overnight digest read.

import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadOvernightDigest } from './overnight-digest';
import { overnightWindow } from './overnight-digest-summary';

describe('loadOvernightDigest degraded scan marking', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: a scan event with outcome degraded inside the window is marked in degraded_kinds with its run's task_kind and the generic degraded_reason
  // @fails-if the digest matches the wrong outcome or window predicate, drops the run join to task_kind, or loses payload degraded_reason on the way out
  it('marks a degraded coach scan via its task run', async () => {
    const db = testDb();
    const now = new Date('2026-10-28T12:00:00Z');
    const { from } = overnightWindow(now);
    const at = new Date(from.getTime() + 7_200_000);
    await db.insert(ai_task_runs).values({
      id: 'tr_degraded_1',
      task_kind: 'CoachTask',
      provider: 'mimo',
      model: 'mimo-v2.5-pro',
      input_hash: 'yuk1578'.padEnd(16, '_'),
      status: 'success',
      started_at: at,
    });
    await writeEvent(db, {
      id: 'coach_scan_degraded_1',
      actor_kind: 'agent',
      actor_ref: 'coach',
      action: 'experimental:coach_scan',
      subject_kind: 'query',
      subject_id: 'coach_trigger_1',
      outcome: 'degraded',
      payload: { today_plan: null, plan_parse_error: true, degraded_reason: 'plan_parse_error' },
      task_run_id: 'tr_degraded_1',
      created_at: at,
    });

    const digest = await loadOvernightDigest(db, now, async () => ({
      scope: 'all_activity',
      records: 0,
      by_currency: [],
      details: [],
    }));
    expect(digest.degraded_kinds).toEqual([
      { task_kind: 'CoachTask', error_count: 1, recent_error_messages: ['plan_parse_error'] },
    ]);
  });
});
