// Coach TodayPlan read path (YUK-143, P0.4 — prepare-for-redraw).
//
// The coach_daily / coach_weekly handlers already produce a full `TodayPlan`
// (DomainTool-grounded) and persist it on the latest `experimental:coach_scan`
// event payload (`payload.today_plan`). Today only the `/today` drawer summary
// (copilot-summary.ts) reads it — and only the `daily_focus` line. There is no
// read path exposing the FULL plan for a page, so the `/coach` page still shows
// only static weekly KPI (`/api/review/weekly`).
//
// This reader surfaces the latest daily TodayPlan (full) + the latest weekly
// run's `weekly_reflection`, so the YUK-169 redraw's `/coach` page can render
// Coach's actual evidence-grounded plan. Read-only; no events written.

import { type TodayPlanT, parseTodayPlan } from '@/core/schema/coach';
import type { Db, Tx } from '@/db/client';
import { getEvents } from '@/server/events/queries';

type DbLike = Db | Tx;

export interface CoachPlanView {
  /** The latest DAILY run's full TodayPlan, or null when Coach hasn't run / output was unparseable. */
  daily_plan: TodayPlanT | null;
  /** ISO timestamp of the latest daily coach run, or null. */
  daily_ran_at: string | null;
  /** The latest WEEKLY run's reflection summary, or null. */
  weekly_reflection: string | null;
  /** ISO timestamp of the latest weekly coach run, or null. */
  weekly_ran_at: string | null;
}

function planFromPayload(payload: unknown): TodayPlanT | null {
  const tp = (payload as Record<string, unknown> | null)?.today_plan;
  if (tp == null) return null;
  try {
    return parseTodayPlan(tp);
  } catch {
    // A non-JSON / schema-invalid plan was persisted with plan_parse_error;
    // the page falls back to the placeholder rather than crashing.
    return null;
  }
}

export interface GetLatestCoachPlanOpts {
  /** How many recent coach_scan events to scan for the latest daily + weekly. */
  scanLimit?: number;
}

/**
 * Reads the latest successful `experimental:coach_scan` events (newest-first)
 * and partitions them by `payload.run_kind` to find the most recent daily +
 * weekly runs. Scans a bounded window so a long gap between weekly runs still
 * resolves (default 25; capped 1..50).
 */
export async function getLatestCoachPlan(
  db: DbLike,
  opts: GetLatestCoachPlanOpts = {},
): Promise<CoachPlanView> {
  const scanLimit = Math.min(50, Math.max(1, opts.scanLimit ?? 25));
  const scans = await getEvents(db, {
    action: 'experimental:coach_scan',
    outcome: 'success',
    limit: scanLimit,
  });

  let daily: (typeof scans)[number] | null = null;
  let weekly: (typeof scans)[number] | null = null;
  for (const ev of scans) {
    const runKind = (ev.payload as Record<string, unknown> | null)?.run_kind;
    if (!daily && runKind === 'daily') daily = ev;
    if (!weekly && runKind === 'weekly') weekly = ev;
    if (daily && weekly) break;
  }

  const weeklyPlan = weekly ? planFromPayload(weekly.payload) : null;
  return {
    daily_plan: daily ? planFromPayload(daily.payload) : null,
    daily_ran_at: daily ? daily.created_at.toISOString() : null,
    weekly_reflection: weeklyPlan?.weekly_reflection ?? null,
    weekly_ran_at: weekly ? weekly.created_at.toISOString() : null,
  };
}
