// YUK-1557 / ADR-0075 C6-2 — deterministic harness scoreboard.
//
// The metric definitions live in ADR-0075 §D7 (M1–M7). This module only reads
// raw tables and folds them; it never invokes a model and never writes business
// state. `m3`/`m4`/`m5` explicitly name the parts of the review's definition
// that the current tables cannot reproduce, instead of presenting a proxy
// definition as measured.
//
// Consumers:
//   - jobs/harness_scoreboard_daily.ts (daily projection event)
//   - api/harness-scoreboard.ts (status page read)
//   - scripts/harness-scoreboard.ts (recompute CLI)

import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { learnerDayWindowUtc, learnerLocalDay } from '@/core/learner-day';
import {
  HARNESS_SCOREBOARD_EVENT_ACTION,
  HARNESS_SCOREBOARD_VERSION,
  type HarnessMetricRayT,
  HarnessScoreboardV1,
  type HarnessScoreboardV1T,
} from '@/core/schema/harness-scoreboard';
import type { Db } from '@/db/client';
import { ai_task_runs, cost_ledger, event, knowledge, question, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

const LOOP_THRESHOLD = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function usageField(usage: unknown, key: string): number | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeToolRow(row: { tool_name: string; input_json: unknown }): {
  key: string;
  layer: 'bridge' | 'mirror' | 'other';
} {
  const mirrorPrefix = 'mcp__loom__';
  const mirror = row.tool_name.startsWith(mirrorPrefix);
  return {
    key: `${mirror ? row.tool_name.slice(mirrorPrefix.length) : row.tool_name}:${createHash(
      'sha256',
    )
      .update(JSON.stringify(row.input_json ?? {}))
      .digest('hex')}`,
    layer: mirror ? 'mirror' : row.tool_name.startsWith('mcp__') ? 'other' : 'bridge',
  };
}

interface ToolGroup {
  task_kind: string;
  bridge: number;
  mirror: number;
  other: number;
}

function toolGroups(
  rows: ReadonlyArray<{
    task_run_id: string;
    task_kind: string;
    tool_name: string;
    input_json: unknown;
  }>,
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  for (const row of rows) {
    const normalized = normalizeToolRow(row);
    const key = `${row.task_run_id}:${normalized.key}`;
    const group = groups.get(key) ?? {
      task_kind: row.task_kind,
      bridge: 0,
      mirror: 0,
      other: 0,
    };
    group[normalized.layer] += 1;
    groups.set(key, group);
  }
  return groups;
}

function addRay(
  bucket: Map<string, { numerator: number; denominator: number }>,
  key: string,
  n: number,
  d: number,
) {
  const row = bucket.get(key) ?? { numerator: 0, denominator: 0 };
  row.numerator += n;
  row.denominator += d;
  bucket.set(key, row);
}

function rays(
  bucket: Map<string, { numerator: number; denominator: number }>,
): HarnessMetricRayT[] {
  return [...bucket.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => ({
      key,
      value: ratio(values.numerator, values.denominator),
      numerator: values.numerator,
      denominator: values.denominator,
    }));
}

export async function computeHarnessScoreboard(
  db: Db,
  input: { fromDay: string; toDay: string; now?: Date },
): Promise<HarnessScoreboardV1T> {
  const { from, to } = learnerDayWindowUtc(input.fromDay, input.toDay);
  const now = input.now ?? new Date();
  const windowWhere = (column: AnyPgColumn) => and(gte(column, from), lt(column, to));

  const runRows = await db
    .select({
      task_kind: ai_task_runs.task_kind,
      status: ai_task_runs.status,
      provider: ai_task_runs.provider,
      model: ai_task_runs.model,
      usage_json: ai_task_runs.usage_json,
      cost_usd: ai_task_runs.cost_usd,
      started_at: ai_task_runs.started_at,
    })
    .from(ai_task_runs)
    .where(windowWhere(ai_task_runs.started_at));

  const m1ByTask = new Map<string, { numerator: number; denominator: number }>();
  const m3ByTask = new Map<string, { numerator: number; denominator: number }>();
  let failedInputTokens = 0;
  let totalInputTokens = 0;
  let terminalRuns = 0;
  let runsMissingUsageFields = 0;
  let failedRuns = 0;
  let failedRunsNullCost = 0;

  for (const run of runRows) {
    const inputTokens = asNumber(usageField(run.usage_json, 'inputTokens'));
    const terminal = run.status !== 'running';
    totalInputTokens += inputTokens;
    addRay(m1ByTask, run.task_kind, run.status === 'failure' ? inputTokens : 0, inputTokens);
    if (terminal) {
      terminalRuns += 1;
      const missing =
        usageField(run.usage_json, 'numTurns') === null ||
        usageField(run.usage_json, 'cacheReadTokens') === null ||
        usageField(run.usage_json, 'cacheWriteTokens') === null;
      if (missing) runsMissingUsageFields += 1;
    }
    if (run.status === 'failure') {
      failedInputTokens += inputTokens;
      failedRuns += 1;
      if (run.cost_usd === null) failedRunsNullCost += 1;
      addRay(m3ByTask, run.task_kind, 1, 1);
    } else {
      addRay(m3ByTask, run.task_kind, 0, 1);
    }
  }

  const toolRows = await db
    .select({
      task_run_id: tool_call_log.task_run_id,
      task_kind: tool_call_log.task_kind,
      tool_name: tool_call_log.tool_name,
      input_json: tool_call_log.input_json,
    })
    .from(tool_call_log)
    .where(windowWhere(tool_call_log.occurred_at));

  const groups = toolGroups(toolRows);
  const m2ByTask = new Map<string, { numerator: number; denominator: number }>();
  let duplicateToolCallRows = 0;
  for (const group of groups.values()) {
    const actualCalls = group.bridge > 0 ? group.bridge : group.mirror + group.other;
    addRay(m2ByTask, group.task_kind, actualCalls > LOOP_THRESHOLD ? 1 : 0, 1);
    duplicateToolCallRows += Math.min(group.bridge, group.mirror);
  }

  const verifierRows = await db
    .select({ action: event.action, outcome: event.outcome })
    .from(event)
    .where(
      and(
        inArray(event.action, ['experimental:source_verify', 'experimental:quiz_verify']),
        gte(event.created_at, from),
        lt(event.created_at, to),
      ),
    );
  const verifierBuckets = new Map<string, { total: number; failed: number }>();
  for (const row of verifierRows) {
    const bucket = verifierBuckets.get(row.action) ?? { total: 0, failed: 0 };
    bucket.total += 1;
    if (row.outcome === 'failure' || row.outcome === 'error') bucket.failed += 1;
    verifierBuckets.set(row.action, bucket);
  }

  const [proposedInWindow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(and(eq(event.action, 'propose'), gte(event.created_at, from), lt(event.created_at, to)));
  const [decidedInWindow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        gte(event.created_at, from),
        lt(event.created_at, to),
        sql`${event.payload}->>'rating' in ('accept','reverse','change_type','dismiss','rollback')`,
      ),
    );
  const [pending] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${event.created_at})::text`,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        lt(event.created_at, to),
        sql`not exists (
          select 1 from ${event} r
          where r.action = 'rate'
            and r.caused_by_event_id = ${event.id}
            and r.created_at < ${to.toISOString()}
            and r.payload->>'rating' in ('accept','reverse','change_type','dismiss','rollback')
        )`,
      ),
    );
  const oldestPending = pending?.oldest ? new Date(pending.oldest) : null;

  const [newQuestions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(question)
    .where(and(gte(question.created_at, from), lt(question.created_at, to)));
  const quizGenEvents = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:quiz_gen'),
        gte(event.created_at, from),
        lt(event.created_at, to),
      ),
    );
  let exactDuplicates = 0;
  for (const row of quizGenEvents) {
    if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
      exactDuplicates += asNumber((row.payload as Record<string, unknown>).exact_duplicate_count);
    }
  }
  const knowledgeRows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(gte(knowledge.created_at, from), lt(knowledge.created_at, to)));
  const nameCounts = new Map<string, number>();
  for (const row of knowledgeRows) {
    const key = row.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  let sameNameKnowledgePairs = 0;
  for (const count of nameCounts.values()) if (count > 1) sameNameKnowledgePairs += count - 1;

  const dailyCostRows = await db
    .select({
      day: sql<string>`to_char(${cost_ledger.occurred_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      cost: sql<number>`coalesce(sum(${cost_ledger.cost}), 0)`,
    })
    .from(cost_ledger)
    .where(
      and(
        eq(cost_ledger.currency, 'USD'),
        gte(cost_ledger.occurred_at, from),
        lt(cost_ledger.occurred_at, to),
      ),
    )
    .groupBy(sql`1`);
  const dailyTokenRows = await db
    .select({
      day: sql<string>`to_char(${ai_task_runs.started_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      tokens: sql<number>`coalesce(sum((${ai_task_runs.usage_json}->>'inputTokens')::numeric), 0)`,
    })
    .from(ai_task_runs)
    .where(windowWhere(ai_task_runs.started_at))
    .groupBy(sql`1`);
  const dailyUserRows = await db
    .select({
      day: sql<string>`to_char(${event.created_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      events: sql<number>`count(*)::int`,
    })
    .from(event)
    .where(and(eq(event.actor_kind, 'user'), gte(event.created_at, from), lt(event.created_at, to)))
    .groupBy(sql`1`);

  const costByDay = new Map(dailyCostRows.map((row) => [row.day, asNumber(row.cost)]));
  const tokensByDay = new Map(dailyTokenRows.map((row) => [row.day, asNumber(row.tokens)]));
  const userByDay = new Map(dailyUserRows.map((row) => [row.day, asNumber(row.events)]));
  const daily: HarnessScoreboardV1T['m6_idle_spend']['daily'] = [];
  for (
    let cursor = Date.parse(`${input.fromDay}T00:00:00.000Z`);
    cursor <= Date.parse(`${input.toDay}T00:00:00.000Z`);
    cursor += DAY_MS
  ) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    daily.push({
      day,
      user_events: userByDay.get(day) ?? 0,
      cost_usd: costByDay.get(day) ?? 0,
      input_tokens: tokensByDay.get(day) ?? 0,
    });
  }
  const idleDays = daily.filter((row) => row.user_events === 0);
  const activeDays = daily.filter((row) => row.user_events > 0);
  const average = (rows: typeof daily, key: 'cost_usd' | 'input_tokens') =>
    rows.length === 0 ? null : rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

  const exaRows = toolRows.filter((row) => row.tool_name.startsWith('mcp__exa__')).length;

  return {
    version: HARNESS_SCOREBOARD_VERSION,
    generated_at: now.toISOString(),
    window: {
      from_day: input.fromDay,
      to_day: input.toDay,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    m1_zero_yield_token_share: {
      value: ratio(failedInputTokens, totalInputTokens),
      failed_input_tokens: failedInputTokens,
      total_input_tokens: totalInputTokens,
      by_task: rays(m1ByTask),
      basis: 'measured',
      note: 'failed=ai_task_runs.status=failure; empty-output runs have no separate outcome column yet.',
    },
    m2_loop_runs: {
      value: rays(m2ByTask).reduce((sum, row) => sum + row.numerator, 0),
      threshold: LOOP_THRESHOLD,
      by_task: rays(m2ByTask),
      basis: 'measured',
      note: 'one (run, tool, canonical input) group; bridge rows win over legacy mirror rows so the pre-YUK-1557 double write cannot inflate a loop.',
    },
    m3_dropped_paid_output: {
      by_task: rays(m3ByTask),
      verifier_rejections: [...verifierBuckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([action, values]) => ({
          action,
          total: values.total,
          failed: values.failed,
          ratio: ratio(values.failed, values.total),
        })),
      basis: 'proxy',
      note: 'proxy definition: by_task = failed terminal runs / terminal runs. Review M3 counts task-specific rejections (QuizGen/source_consistency/notes/KR); only verifier events expose a raw reject count, so the two cannot be added.',
    },
    m4_inbox_backlog: {
      pending: asNumber(pending?.count),
      oldest_pending_age_days:
        oldestPending === null
          ? null
          : Math.max(0, (now.getTime() - oldestPending.getTime()) / DAY_MS),
      proposed_in_window: asNumber(proposedInWindow?.count),
      decided_in_window: asNumber(decidedInWindow?.count),
      basis: 'proxy',
      note: 'proxy definition: pending/oldest are proposals created before window end with no terminal rate event (correction/staleness folds are not applied); closable/conflict partitions are not exposed by the raw rows.',
    },
    m5_duplicate_rate: {
      new_questions: asNumber(newQuestions?.count),
      exact_duplicates: exactDuplicates,
      duplicate_ratio: ratio(exactDuplicates, asNumber(newQuestions?.count) + exactDuplicates),
      same_name_knowledge_pairs: sameNameKnowledgePairs,
      basis: 'proxy',
      note: 'proxy definition: exact duplicates come from experimental:quiz_gen exact_duplicate_count; source/jyeoo duplicate rejections are not counted in this version.',
    },
    m6_idle_spend: {
      currency: 'USD',
      daily,
      idle_days: idleDays.length,
      idle_daily_avg_usd: average(idleDays, 'cost_usd'),
      active_daily_avg_usd: average(activeDays, 'cost_usd'),
      basis: 'measured',
      note: 'idle day = zero actor_kind=user events in that Asia/Shanghai calendar day; USD rows only, CNY is never mixed in.',
    },
    health: {
      checked_at: now.toISOString(),
      terminal_runs: terminalRuns,
      runs_missing_usage_fields: runsMissingUsageFields,
      duplicate_tool_call_rows: duplicateToolCallRows,
      exa_tool_call_rows: exaRows,
      failed_runs: failedRuns,
      failed_runs_null_cost: failedRunsNullCost,
    },
  };
}

/** Persist one deterministic daily projection; first write wins for a day. */
export async function writeHarnessScoreboard(
  db: Db,
  scoreboard: HarnessScoreboardV1T,
): Promise<string> {
  const id = `harness_scoreboard_${scoreboard.window.from_day}_${scoreboard.window.to_day}`;
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'harness_scoreboard',
    action: HARNESS_SCOREBOARD_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: scoreboard,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    // Meta projection: never feed the memory pipeline.
    ingest_at: new Date(scoreboard.generated_at),
    created_at: new Date(scoreboard.generated_at),
  });
  return id;
}

/** Latest persisted scoreboard (status page read). */
export async function readLatestHarnessScoreboard(
  db: Db,
  now: Date = new Date(),
): Promise<{ scoreboard: HarnessScoreboardV1T; age_hours: number } | null> {
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(eq(event.action, HARNESS_SCOREBOARD_EVENT_ACTION))
    .orderBy(sql`${event.created_at} desc`)
    .limit(1);
  const row = rows[0];
  if (!row || row.payload === null || typeof row.payload !== 'object') return null;
  const parsed = HarnessScoreboardV1.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    scoreboard: parsed.data,
    age_hours: Math.max(0, (now.getTime() - row.created_at.getTime()) / (60 * 60 * 1000)),
  };
}

/** Run the daily job for yesterday's Asia/Shanghai day. */
export async function runHarnessScoreboardDaily(
  db: Db,
  now: Date = new Date(),
): Promise<{ eventId: string; scoreboard: HarnessScoreboardV1T }> {
  const toDay = learnerLocalDay(new Date(now.getTime() - DAY_MS));
  const scoreboard = await computeHarnessScoreboard(db, { fromDay: toDay, toDay, now });
  const eventId = await writeHarnessScoreboard(db, scoreboard);
  return { eventId, scoreboard };
}
