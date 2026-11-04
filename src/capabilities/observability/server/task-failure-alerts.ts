// The only place that decides "this task kind keeps failing", read straight from
// ai_task_runs. Two rules, thresholds from the config registry:
//   consecutive — failures since the kind's last success reach N (latest failure not stale);
//   rate        — inside the window, terminal runs ≥ MIN_RUNS and failure share > RATE.
// A kind with an active consecutive alert does not also raise a rate alert.
// "Failure" is isTaskFailureOutcome: retried attempts, sweeper-converged rows and
// cancelled help attempts are neither failures nor successes, so they are invisible to
// both rules — a retry that ends in success resets the streak, one that ends in failure
// counts once. Run order is finished_at, so a concurrent success that finishes last
// still ends a streak; while a run that started before the streak's first failure is
// still in flight, the streak waits a tick instead of alerting. Only runs younger than
// STUCK_RUN_THRESHOLD_MS hold it: every call budget is shorter, so an older 'running'
// row is a dead writer the sweeper will converge, and it cannot hold an alert back.
//
// Alert ids are deterministic and double as the event id, so recording is
// write-once per episode: a consecutive episode is keyed by its first failed run
// (a success ends it, the next failure opens a new one); a rate episode is keyed
// by kind + learner day. The read surface evaluates live and never writes; the
// hourly job is the only writer.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { CONFIG_REGISTRY, getConfig } from '@/core/config/store';
import { learnerLocalDay } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  CONFIG_INCOMPLETE_EVENT_ACTION,
  ConfigIncompletePayloadSchema,
  checkConfigCompleteness,
} from '@/kernel/config-completeness';
import { writeEvents } from '@/kernel/events';
import { isTaskFailureOutcome } from '@/kernel/records/ai-attempt-facts';

export const TASK_FAILURE_ALERT_EVENT_ACTION = 'experimental:task_failure_alert';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface TaskFailureAlertThresholds {
  consecutive_failures: number;
  window_hours: number;
  failure_rate_above: number;
  min_runs_in_window: number;
  stale_after_days: number;
}

export interface TaskFailureAlert {
  /** Deterministic alert id; equals the recorded event id. */
  id: string;
  task_kind: string;
  rule: 'consecutive' | 'rate';
  failures: number;
  /** Terminal runs counted by the rule (consecutive: equals failures). */
  runs: number;
  /** ISO timestamps throughout: this is also the HTTP and Start wire shape. */
  /** consecutive: first failure of the streak; rate: window start. */
  since: string;
  last_failure_at: string;
  last_success_at: string | null;
  latest_run_id: string;
  latest_finish_reason: string | null;
}

export interface TaskFailureAlertRead extends TaskFailureAlert {
  recorded_event_id: string | null;
  recorded_at: string | null;
}

/** A process running without a required setting; names only, never values. */
export interface ConfigIncompleteAlert {
  process: 'api' | 'worker';
  missing: string[];
  /** api: this read's live check; worker: when its latest boot reported it. */
  seen_at: string;
}

export interface TaskFailureAlertsRead {
  checked_at: string;
  thresholds: TaskFailureAlertThresholds;
  alerts: TaskFailureAlertRead[];
  config_incomplete: ConfigIncompleteAlert[];
}

function configNumber(key: string): number {
  const value = getConfig(key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return CONFIG_REGISTRY[key]?.codeDefault as number;
}

export function readTaskFailureAlertThresholds(): TaskFailureAlertThresholds {
  return {
    consecutive_failures: configNumber('TASK_FAILURE_ALERT_CONSECUTIVE'),
    window_hours: configNumber('TASK_FAILURE_ALERT_WINDOW_HOURS'),
    failure_rate_above: configNumber('TASK_FAILURE_ALERT_RATE'),
    min_runs_in_window: configNumber('TASK_FAILURE_ALERT_MIN_RUNS'),
    stale_after_days: configNumber('TASK_FAILURE_ALERT_STALE_DAYS'),
  };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

type StreakRow = {
  task_kind: string;
  failures: number | string;
  first_failure_at: Date | string;
  last_failure_at: Date | string;
  first_failure_run_id: string;
  latest_run_id: string;
  latest_finish_reason: string | null;
  last_success_at: Date | string | null;
  in_flight_before_streak: boolean;
};

type WindowRow = {
  task_kind: string;
  runs: number | string;
  failures: number | string;
  last_failure_at: Date | string;
  latest_run_id: string;
  latest_finish_reason: string | null;
  last_success_at: Date | string | null;
};

export async function evaluateTaskFailureAlerts(
  db: Db | Tx,
  thresholds: TaskFailureAlertThresholds,
  now: Date,
): Promise<TaskFailureAlert[]> {
  const staleCutoff = new Date(now.getTime() - thresholds.stale_after_days * DAY_MS);
  const windowStart = new Date(now.getTime() - thresholds.window_hours * HOUR_MS);
  const liveRunCutoff = new Date(now.getTime() - STUCK_RUN_THRESHOLD_MS);

  const streakRows = await db.execute<StreakRow>(sql`
    with last_success as (
      select task_kind, max(finished_at) as at
      from ai_task_runs
      where status = 'success' and finished_at <= ${now.toISOString()}::timestamptz
      group by task_kind
    ),
    in_flight as (
      select task_kind, min(started_at) as earliest_start
      from ai_task_runs
      where status = 'running'
        and started_at > ${liveRunCutoff.toISOString()}::timestamptz
        and started_at <= ${now.toISOString()}::timestamptz
      group by task_kind
    )
    select
      r.task_kind,
      count(*)::int as failures,
      min(r.finished_at) as first_failure_at,
      max(r.finished_at) as last_failure_at,
      (array_agg(r.id order by r.finished_at asc, r.id asc))[1] as first_failure_run_id,
      (array_agg(r.id order by r.finished_at desc, r.id desc))[1] as latest_run_id,
      (array_agg(r.finish_reason order by r.finished_at desc, r.id desc))[1]
        as latest_finish_reason,
      max(ls.at) as last_success_at,
      coalesce(max(f.earliest_start) < min(r.finished_at), false) as in_flight_before_streak
    from ai_task_runs r
    left join last_success ls on ls.task_kind = r.task_kind
    left join in_flight f on f.task_kind = r.task_kind
    where ${isTaskFailureOutcome(sql`r.status`, sql`r.finish_reason`, sql`r.usage_json`)}
      and r.finished_at <= ${now.toISOString()}::timestamptz
      and (ls.at is null or r.finished_at > ls.at)
    group by r.task_kind
    having count(*) >= ${thresholds.consecutive_failures}
      and max(r.finished_at) >= ${staleCutoff.toISOString()}::timestamptz
  `);

  // A held streak still keeps its kind out of the rate rule.
  const streakKinds = new Set(streakRows.map((row) => row.task_kind));
  const alerts: TaskFailureAlert[] = streakRows
    .filter((row) => !row.in_flight_before_streak)
    .map((row) => ({
      id: `task_failure_alert:consecutive:${row.task_kind}:${row.first_failure_run_id}`,
      task_kind: row.task_kind,
      rule: 'consecutive',
      failures: Number(row.failures),
      runs: Number(row.failures),
      since: iso(row.first_failure_at),
      last_failure_at: iso(row.last_failure_at),
      last_success_at: nullableIso(row.last_success_at),
      latest_run_id: row.latest_run_id,
      latest_finish_reason: row.latest_finish_reason,
    }));

  // Window membership stays on started_at (attempts launched in the window), the
  // column ai_task_runs_status_idx covers; ordering inside it is finished_at.
  const failed = isTaskFailureOutcome(sql`status`, sql`finish_reason`, sql`usage_json`);
  const windowRows = await db.execute<WindowRow>(sql`
    select
      task_kind,
      count(*)::int as runs,
      (count(*) filter (where ${failed}))::int as failures,
      max(finished_at) filter (where ${failed}) as last_failure_at,
      (array_agg(id order by finished_at desc, id desc) filter (where ${failed}))[1]
        as latest_run_id,
      (array_agg(finish_reason order by finished_at desc, id desc) filter (where ${failed}))[1]
        as latest_finish_reason,
      max(finished_at) filter (where status = 'success') as last_success_at
    from ai_task_runs
    where (status = 'success' or ${failed})
      and started_at >= ${windowStart.toISOString()}::timestamptz
      and started_at <= ${now.toISOString()}::timestamptz
    group by task_kind
    having count(*) >= ${thresholds.min_runs_in_window}
      and (count(*) filter (where ${failed}))::float8 / count(*)
        > ${thresholds.failure_rate_above}
  `);

  const day = learnerLocalDay(now);
  for (const row of windowRows) {
    if (streakKinds.has(row.task_kind)) continue;
    alerts.push({
      id: `task_failure_alert:rate:${row.task_kind}:${day}`,
      task_kind: row.task_kind,
      rule: 'rate',
      failures: Number(row.failures),
      runs: Number(row.runs),
      since: windowStart.toISOString(),
      last_failure_at: iso(row.last_failure_at),
      // In-window only; a rate alert means successes still happen, just too rarely.
      last_success_at: nullableIso(row.last_success_at),
      latest_run_id: row.latest_run_id,
      latest_finish_reason: row.latest_finish_reason,
    });
  }

  return alerts.sort(
    (left, right) =>
      right.last_failure_at.localeCompare(left.last_failure_at) ||
      left.task_kind.localeCompare(right.task_kind),
  );
}

async function recordedAlerts(db: Db | Tx, ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: event.id, created_at: event.created_at })
    .from(event)
    .where(inArray(event.id, ids));
  return new Map(rows.map((row) => [row.id, row.created_at]));
}

// The API answers for itself live. The worker only reports at boot (one event per UTC day),
// so its row is its latest report inside a day and can outlive a fix by up to that long.
async function loadConfigIncomplete(db: Db | Tx, now: Date): Promise<ConfigIncompleteAlert[]> {
  const out: ConfigIncompleteAlert[] = [];
  const api = checkConfigCompleteness();
  if (!api.complete) out.push({ process: 'api', missing: api.missing, seen_at: now.toISOString() });
  const [row] = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, CONFIG_INCOMPLETE_EVENT_ACTION),
        gte(event.created_at, new Date(now.getTime() - DAY_MS)),
        sql`${event.payload}->>'process' = 'worker'`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const worker = row ? ConfigIncompletePayloadSchema.safeParse(row.payload) : null;
  if (row && worker?.success) {
    out.push({
      process: 'worker',
      missing: worker.data.missing,
      seen_at: row.created_at.toISOString(),
    });
  }
  return out;
}

/** Read-only: live evaluation plus whether each alert episode has been recorded. */
export async function loadTaskFailureAlerts(
  db: Db | Tx,
  now: Date = new Date(),
): Promise<TaskFailureAlertsRead> {
  const thresholds = readTaskFailureAlertThresholds();
  const alerts = await evaluateTaskFailureAlerts(db, thresholds, now);
  const recorded = await recordedAlerts(
    db,
    alerts.map((alert) => alert.id),
  );
  const configIncomplete = await loadConfigIncomplete(db, now);
  return {
    checked_at: now.toISOString(),
    thresholds,
    config_incomplete: configIncomplete,
    alerts: alerts.map((alert) => {
      const recordedAt = recorded.get(alert.id) ?? null;
      return {
        ...alert,
        recorded_event_id: recordedAt ? alert.id : null,
        recorded_at: recordedAt?.toISOString() ?? null,
      };
    }),
  };
}

/** Job entry: write one event per new alert episode; re-runs are no-ops. */
export async function recordTaskFailureAlerts(
  db: Db,
  now: Date = new Date(),
): Promise<{ active: number; recorded: string[] }> {
  const read = await loadTaskFailureAlerts(db, now);
  const fresh = read.alerts.filter((alert) => alert.recorded_event_id === null);
  await writeEvents(
    db,
    fresh.map((alert) => ({
      id: alert.id,
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'task_failure_alert',
      action: TASK_FAILURE_ALERT_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: alert.id,
      outcome: 'failure',
      payload: {
        version: 1,
        rule: alert.rule,
        task_kind: alert.task_kind,
        failures: alert.failures,
        runs: alert.runs,
        since: alert.since,
        last_failure_at: alert.last_failure_at,
        last_success_at: alert.last_success_at,
        latest_run_id: alert.latest_run_id,
        latest_finish_reason: alert.latest_finish_reason,
        thresholds: read.thresholds,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      // Operational record: never feed the memory pipeline.
      ingest_at: now,
      created_at: now,
    })),
  );
  return { active: read.alerts.length, recorded: fresh.map((alert) => alert.id) };
}
