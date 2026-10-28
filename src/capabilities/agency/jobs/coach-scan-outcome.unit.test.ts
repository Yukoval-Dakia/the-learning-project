// YUK-1578 — scan-event outcome trichotomy through the real runCoach →
// runAgencyProposalScan assembly, with only the external seams injected
// (no DB, no provider). @invariant markers follow the repo test policy.

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // The module graph transitively imports @/db/client, which validates env at import
  // time; the pool itself is never opened in this file.
  process.env.DATABASE_URL ??= 'postgres://unit:unit@127.0.0.1:5432/unit';
});

import type { WriteEventInput } from '@/kernel/events';
import { runCoach } from './coach_daily';

const VALID_PLAN = JSON.stringify({
  daily_focus: '今天优先复习错题高频知识点。',
  review_session_proposal: { knowledge_focus: ['k1'], intent_tags: ['weak_recovery'] },
  plan_adjustments: [],
  maintenance_proposals: [],
});

type ScanDeps = Parameters<typeof runCoach>[2];

function scanDeps(
  events: WriteEventInput[],
  run: () => Promise<{ task_run_id: string; cost_usd: number; text: string }>,
): ScanDeps {
  return {
    now: () => new Date('2026-10-28T04:00:00Z'),
    writeEventFn: async (_db, input) => {
      events.push(input);
      return input.id;
    },
    listProposalInboxRowsFn: async () => [],
    listActiveGoalsFn: async () => [],
    listActiveItemsFn: async () => [],
    loadProposalFeedbackFn: async () => [],
    readAgentNotesFn: async () => [],
    resolvePlanInputsFn: async () => ({
      due_count: 12,
      due_by_subject: [{ subject_id: 's_math', due_count: 12 }],
      budget_minutes: 60,
      question_minutes: 5,
      question_minutes_source: 'observed' as const,
      question_minutes_sample_count: 10,
    }),
    runAgentTaskFn: run,
  };
}

function lastScan(events: WriteEventInput[]): WriteEventInput {
  const scan = events.find((e) => e.action === 'experimental:coach_scan');
  if (!scan) throw new Error('no coach_scan event was written');
  return scan;
}

describe('runCoach scan-event outcome', () => {
  // @invariant data: a completed run records outcome degraded exactly when the TodayPlan failed to parse, and the lifted outcome key never reaches the payload
  // @fails-if the scan owner stamps success for unparseable plans, drops the degraded stamp or the payload reasons, or spreads the outcome key into the payload
  it.each([
    {
      name: 'garbage model output degrades',
      text: 'the model rambled, no JSON',
      outcome: 'degraded',
    },
    { name: 'valid plan succeeds', text: VALID_PLAN, outcome: 'success' },
  ])('$name', async ({ text, outcome }) => {
    const events: WriteEventInput[] = [];
    await runCoach(
      {} as never,
      'daily',
      scanDeps(events, async () => ({ task_run_id: 'tr_1', cost_usd: 0.002, text })),
    );
    const scan = lastScan(events);
    expect(scan.outcome).toBe(outcome);
    expect(scan.payload).not.toHaveProperty('outcome');
    if (outcome === 'degraded') {
      expect(scan.payload).toMatchObject({
        today_plan: null,
        plan_parse_error: true,
        degraded_reason: 'plan_parse_error',
      });
    } else {
      expect(scan.payload).toMatchObject({ daily_focus: '今天优先复习错题高频知识点。' });
      expect(scan.payload).not.toHaveProperty('plan_parse_error');
      expect(scan.payload).not.toHaveProperty('degraded_reason');
    }
  });

  // @invariant data: a runner exception keeps the execution-failure meaning — outcome failure, error payload, and the cron rethrow all survive
  // @fails-if the catch branch swallows the error or stamps success/degraded for a crashed run
  it('rethrows a runner failure and records outcome failure', async () => {
    const events: WriteEventInput[] = [];
    await expect(
      runCoach(
        {} as never,
        'daily',
        scanDeps(events, async () => {
          throw new Error('provider exploded');
        }),
      ),
    ).rejects.toThrow('provider exploded');
    const scan = lastScan(events);
    expect(scan.outcome).toBe('failure');
    expect(scan.payload).toMatchObject({ error: 'provider exploded' });
  });
});
