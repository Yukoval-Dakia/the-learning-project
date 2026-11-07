// The only place that decides "this task kind keeps failing", read straight from
// ai_task_runs. Failure rules use thresholds from the config registry:
//   consecutive — failures since the kind's last success reach N (latest failure not stale);
//   rate        — inside the window, terminal runs ≥ MIN_RUNS and failure share > RATE.
// Unsealed deliveries raise an operational alert independently of failure counts.
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
//
// Optional web search (Exa) degrading never fails the Copilot turn, so it is NOT
// a task-failure alert: it rides its own `dependency_notices` list with learner
// copy, is never written as an event, and only counts runs that carry positive
// startup evidence (connected / unavailable). A run that never mounted the
// dependency is skipped, not treated as recovery.

import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { CONFIG_REGISTRY, getConfig } from '@/core/config/store';
import { learnerLocalDay } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';
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
  rule: 'consecutive' | 'rate' | 'unsealed';
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

/**
 * An optional dependency degraded across a run streak. Deliberately separate
 * from task-failure alerts: the Copilot reply still succeeds, so this must never
 * render as "a task keeps failing" or be recorded as a failure event.
 */
export interface DependencyNotice {
  dependency: 'web_search';
  /** unknown causes count as network. */
  category: 'authorization' | 'network';
  /** Learner copy; never names the provider, host, key or cause. */
  learner_title: string;
  learner_detail: string;
  failures: number;
  since: string;
  last_failure_at: string;
  latest_run_id: string;
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
  dependency_notices: DependencyNotice[];
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

/**
 * Optional web search degrading does not fail the Copilot run, so it never enters
 * the task-failure rules above. A streak of this many consecutive CopilotTask
 * runs whose dependency failed raises its own notice; a connected run ends it,
 * and runs without recorded evidence (no Exa mount, older rows) are skipped
 * rather than treated as recovery. Three keeps a single blip quiet while a wrong
 * key or a dead endpoint surfaces within one learner turn or two.
 */
export const DEPENDENCY_NOTICE_STREAK = 3;

/**
 * A notice is live only while its streak is recent. The read runs on every /today
 * load, so the window bounds the scan to ai_task_runs_task_kind_idx and stops a
 * long-fixed outage from lingering forever.
 */
export const DEPENDENCY_NOTICE_WINDOW_DAYS = 7;

const DEPENDENCY_COPY = {
  authorization: {
    title: '网页搜索的授权失效了',
    detail: '需要重新配置后才能恢复，学伴先不查网页，其他学习功能照常。',
  },
  network: {
    title: '网页搜索连不上了',
    detail: '学伴先不查网页，其他学习功能照常。',
  },
} as const;

function finishedIso(value: Date | string | null): string {
  if (value === null) throw new Error('terminal ai_task_runs row without finished_at');
  return iso(value);
}

type DependencyEvidence = 'connected' | 'unavailable';

type UsageJson = (typeof ai_task_runs.$inferSelect)['usage_json'];

/** Positive startup evidence: the key exists only when the dependency was mounted. */
function dependencyEvidence(usage: UsageJson): DependencyEvidence | undefined {
  const dependency = usage.transport?.startup_dependency;
  if (dependency?.status === 'connected' || dependency?.status === 'unavailable') {
    return dependency.status;
  }
  // Rows written before the merged shape: a recorded failure still counts.
  const legacy = usage.transport?.startup_dependency_failures;
  return Array.isArray(legacy) && legacy.length > 0 ? 'unavailable' : undefined;
}

function dependencyFailureCategory(usage: UsageJson): 'authorization' | 'network' {
  const merged = usage.transport?.startup_dependency?.failure;
  const failures = merged ? [merged] : usage.transport?.startup_dependency_failures;
  if (!Array.isArray(failures)) return 'network';
  const unauthorized = failures.some((failure) => {
    const causes = Array.isArray(failure.cause) ? failure.cause : [];
    return causes.some(
      (link: { code?: string | number }) => link.code === 401 || link.code === 403,
    );
  });
  return unauthorized ? 'authorization' : 'network';
}

async function evaluateDependencyNotices(db: Db | Tx, now: Date): Promise<DependencyNotice[]> {
  const windowStart = new Date(now.getTime() - DEPENDENCY_NOTICE_WINDOW_DAYS * DAY_MS);
  const isFailure = sql<boolean>`${isTaskFailureOutcome(sql`status`, sql`finish_reason`, sql`usage_json`)}`;
  const isSuccess = sql<boolean>`(status = 'success'
    and finish_reason is distinct from 'reply_unsealed'
    and (usage_json -> 'help_latency' ->> 'terminal') is distinct from 'cancelled')`;
  const hasEvidence = sql<boolean>`((((usage_json -> 'transport' -> 'startup_dependency') ->> 'status')
      in ('connected', 'unavailable'))
    or ((usage_json -> 'transport') ? 'startup_dependency_failures'))`;
  const rows = await db
    .select({
      id: ai_task_runs.id,
      finished_at: ai_task_runs.finished_at,
      usage_json: ai_task_runs.usage_json,
      is_failure: isFailure,
      is_success: isSuccess,
    })
    .from(ai_task_runs)
    .where(
      and(
        eq(ai_task_runs.task_kind, 'CopilotTask'),
        inArray(ai_task_runs.status, ['success', 'failure']),
        isNotNull(ai_task_runs.finished_at),
        gte(ai_task_runs.started_at, windowStart),
        lte(ai_task_runs.finished_at, now),
        hasEvidence,
      ),
    )
    .orderBy(desc(ai_task_runs.finished_at), desc(ai_task_runs.id));

  // Walk newest-first. A connected handshake ends the streak; a run whose
  // dependency failed counts regardless of whether the Copilot turn itself
  // succeeded — a degraded reply that still answers is exactly the case this
  // notice exists for. A retried attempt, sweeper convergence, unsealed reply or
  // cancelled help attempt is skipped without counting or resetting.
  const streak: { id: string; finished_at: Date | string; usage_json: UsageJson }[] = [];
  for (const row of rows) {
    if (row.finished_at === null) continue;
    if (!row.is_failure && !row.is_success) continue;
    const evidence = dependencyEvidence(row.usage_json);
    if (evidence === 'connected') break;
    if (evidence !== 'unavailable') continue;
    streak.push({ id: row.id, finished_at: row.finished_at, usage_json: row.usage_json });
  }
  if (streak.length < DEPENDENCY_NOTICE_STREAK) return [];

  const latest = streak[0];
  const oldest = streak[streak.length - 1];
  const category = dependencyFailureCategory(latest.usage_json);
  const copy = DEPENDENCY_COPY[category];
  return [
    {
      dependency: 'web_search',
      category,
      learner_title: copy.title,
      learner_detail: copy.detail,
      failures: streak.length,
      since: finishedIso(oldest.finished_at),
      last_failure_at: finishedIso(latest.finished_at),
      latest_run_id: latest.id,
    },
  ];
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

  const unsealedRows = await db.execute<{
    id: string;
    task_kind: string;
    finished_at: Date | string;
  }>(sql`
    select distinct on (task_kind) id, task_kind, finished_at
    from ai_task_runs
    where status in ('success', 'failure') and finish_reason = 'reply_unsealed'
      and finished_at >= ${staleCutoff.toISOString()}::timestamptz
      and finished_at <= ${now.toISOString()}::timestamptz
    order by task_kind, finished_at desc, id desc
  `);
  for (const row of unsealedRows) {
    alerts.push({
      id: `task_failure_alert:unsealed:${row.task_kind}:${row.id}`,
      task_kind: row.task_kind,
      rule: 'unsealed',
      failures: 0,
      runs: 1,
      since: iso(row.finished_at),
      last_failure_at: iso(row.finished_at),
      last_success_at: iso(row.finished_at),
      latest_run_id: row.id,
      latest_finish_reason: 'reply_unsealed',
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
  const dependencyNotices = await evaluateDependencyNotices(db, now);
  const recorded = await recordedAlerts(
    db,
    alerts.map((alert) => alert.id),
  );
  const configIncomplete = await loadConfigIncomplete(db, now);
  return {
    checked_at: now.toISOString(),
    thresholds,
    config_incomplete: configIncomplete,
    dependency_notices: dependencyNotices,
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
      outcome: alert.rule === 'unsealed' ? 'success' : 'failure',
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
