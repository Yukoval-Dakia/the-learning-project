// YUK-1560 — 资格判定的读表侧。一次夜间 tick 读完共享信号，再按 job 投影。

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { EMBED_VERSION } from '@/core/embed-source';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  cost_ledger,
  dag_orchestration_node,
  event,
  knowledge,
  knowledge_edge,
  memory_brief_note,
  question,
} from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import {
  type EligibilityDecision,
  LEARNING_EVENT_ACTIONS,
  MEMORY_BRIEF_SWEEP_JOB,
  type NightlySignals,
  REFLECTION_BRIEF_SCOPE_KEYS,
  classifyActivityTier,
} from '@/kernel/nightly-eligibility';
import { loadReturnStockGaps } from '@/kernel/read-models/return-stock';

const TERMINAL_FOR_HISTORY = ['succeeded', 'failed', 'skipped', 'not_needed', 'degraded'] as const;

export interface NightlyContext {
  forJob(jobName: string): NightlySignals;
}

export async function loadNightlyContext(
  db: Db,
  now: Date,
  jobNames: readonly string[],
  opts?: { before?: Date },
): Promise<NightlyContext> {
  const names = [...new Set(jobNames)];
  const dagNames = names.filter((name) => name !== MEMORY_BRIEF_SWEEP_JOB);
  const [
    lastLearner,
    treeWatermark,
    embedPending,
    returnStockShort,
    pendingEdgeProposals,
    history,
    briefWatermark,
  ] = await Promise.all([
    loadLastLearnerEvent(db, opts?.before),
    loadTreeWatermark(db),
    loadEmbedPending(db),
    loadReturnStockShort(db),
    names.includes('frontier_fill_nightly') ? loadPendingEdgeProposalCount(db) : Promise.resolve(0),
    loadJobHistory(db, dagNames),
    names.includes(MEMORY_BRIEF_SWEEP_JOB) ? loadBriefWatermark(db) : Promise.resolve(null),
  ]);

  const tier = classifyActivityTier({
    now,
    lastLearnerEventAt: lastLearner,
    examWindow: false,
  });
  const lastLearnerEventAt = lastLearner ? lastLearner.toISOString() : null;

  return {
    forJob(jobName: string): NightlySignals {
      const row = history.get(jobName);
      const lastSuccess =
        jobName === MEMORY_BRIEF_SWEEP_JOB ? briefWatermark : (row?.lastSuccess ?? null);
      return {
        job: jobName,
        tier,
        lastLearnerEventAt,
        examWindow: false,
        newLearnerEvidence: isNewer(lastLearner, lastSuccess),
        treeChanged: isNewer(treeWatermark, lastSuccess),
        embedPending,
        findingsOpen: 0,
        pendingEdgeProposals,
        returnStockShort,
        degradedNights: degradedStreak(row?.recent ?? []),
      };
    },
  };
}

export function noteEligibilitySkip(
  jobName: string,
  decision: Extract<EligibilityDecision, { run: false }>,
): void {
  if (decision.defect === 'consecutive_degraded') {
    console.error(
      `[harness_defect] '${jobName}' ${decision.reason}; harness_defect finding is not written (P4)`,
    );
  }
  console.warn(`[eligibility] '${jobName}' not_needed: ${decision.reason}`);
}

/** 日费用只告警。没有硬上限，也不把不同币种加在一起。 */
export async function warnDailyCostDoesNotBlock(db: Db, now: Date): Promise<void> {
  try {
    const start = shanghaiDayStart(now);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        currency: cost_ledger.currency,
        total: sql<number>`coalesce(sum(${cost_ledger.cost}), 0)::float8`,
      })
      .from(cost_ledger)
      .where(and(gte(cost_ledger.occurred_at, start), lt(cost_ledger.occurred_at, end)))
      .groupBy(cost_ledger.currency)
      .orderBy(cost_ledger.currency);
    const parts =
      rows.length === 0
        ? 'no rows'
        : rows.map((row) => `${row.currency} ${Number(row.total).toFixed(4)}`).join(', ');
    console.warn(
      `[orchestrator] daily cost so far (${parts}); alert only, does not block the nightly run`,
    );
  } catch (err) {
    console.error('[orchestrator] daily cost alert failed; nightly run continues', err);
  }
}

function isNewer(eventAt: Date | null, watermark: Date | null): boolean {
  if (!eventAt) return false;
  if (!watermark) return true;
  return eventAt.getTime() > watermark.getTime();
}

function degradedStreak(rows: { status: string; finishedAt: Date | null }[]): number {
  const ordered = [...rows].sort(
    (a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0),
  );
  let streak = 0;
  for (const row of ordered) {
    if (row.status !== 'degraded') break;
    streak += 1;
  }
  return streak;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as T[];
  }
  return [];
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function loadPendingEdgeProposalCount(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number | string }>(
    await db.execute(sql`
      SELECT count(*)::int AS n
      FROM (
        SELECT DISTINCT
          propose_event.payload->>'from_knowledge_id',
          propose_event.payload->>'to_knowledge_id',
          propose_event.payload->>'relation_type'
        FROM event propose_event
        WHERE propose_event.action = 'propose'
          AND propose_event.subject_kind = 'knowledge_edge'
          AND jsonb_typeof(propose_event.payload->'from_knowledge_id') = 'string'
          AND jsonb_typeof(propose_event.payload->'to_knowledge_id') = 'string'
          AND jsonb_typeof(propose_event.payload->'relation_type') = 'string'
          AND (propose_event.payload->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'
          AND (propose_event.payload->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'
          AND NOT EXISTS (
            SELECT 1 FROM event rate_event
            WHERE rate_event.action = 'rate'
              AND rate_event.subject_kind = 'knowledge_edge'
              AND rate_event.caused_by_event_id = propose_event.id
          )
          AND EXISTS (
            SELECT 1 FROM ai_task_runs
            WHERE ai_task_runs.id = propose_event.task_run_id
              AND ai_task_runs.task_kind = 'FrontierPrerequisiteTask'
          )
      ) pending_keys
    `),
  );
  return Number(row?.n ?? 0);
}

async function loadLastLearnerEvent(db: Db, before?: Date): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${event.created_at})` })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNING_EVENT_ACTIONS]),
        eventAllowsDerivationSql(),
        before ? lt(event.created_at, before) : undefined,
      ),
    );
  return asDate(row?.at);
}

async function loadTreeWatermark(db: Db): Promise<Date | null> {
  const [row] = rowsOf<{ watermark: unknown }>(
    await db.execute(sql`
      SELECT GREATEST(
        (SELECT max(${knowledge.updated_at}) FROM ${knowledge}),
        (SELECT max(${knowledge_edge.created_at}) FROM ${knowledge_edge} WHERE ${knowledge_edge.archived_at} IS NULL)
      ) AS watermark
    `),
  );
  return asDate(row?.watermark);
}

async function loadEmbedPending(db: Db): Promise<boolean> {
  const questionStale = or(
    isNull(question.embedding),
    isNull(question.embed_version),
    lt(question.embed_version, EMBED_VERSION),
  );
  const [pendingQuestion] = await db
    .select({ id: question.id })
    .from(question)
    .where(and(questionStale, notDraftPredicate(question.draft_status)))
    .limit(1);
  if (pendingQuestion) return true;
  const knowledgeStale = or(
    isNull(knowledge.embedding),
    isNull(knowledge.embed_version),
    lt(knowledge.embed_version, EMBED_VERSION),
  );
  const [pendingKnowledge] = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(knowledgeStale, isNull(knowledge.archived_at)))
    .limit(1);
  return Boolean(pendingKnowledge);
}

async function loadReturnStockShort(db: Db): Promise<boolean> {
  const gaps = await loadReturnStockGaps(db);
  return gaps.length > 0;
}

interface HistoryRow {
  lastSuccess: Date | null;
  recent: { status: string; finishedAt: Date | null }[];
}

async function loadJobHistory(db: Db, jobNames: string[]): Promise<Map<string, HistoryRow>> {
  const out = new Map<string, HistoryRow>();
  if (jobNames.length === 0) return out;
  const names = sql.join(
    jobNames.map((name) => sql`${name}`),
    sql`, `,
  );
  const successes = rowsOf<{ job_name: string; finished_at: unknown }>(
    await db.execute(sql`
    SELECT ${dag_orchestration_node.job_name} AS job_name,
           max(${dag_orchestration_node.finished_at}) AS finished_at
    FROM ${dag_orchestration_node}
    WHERE ${dag_orchestration_node.job_name} IN (${names})
      AND ${dag_orchestration_node.status} = 'succeeded'
    GROUP BY ${dag_orchestration_node.job_name}
  `),
  );
  const recent = rowsOf<{ job_name: string; status: string; finished_at: unknown }>(
    await db.execute(sql`
    SELECT job_name, status, finished_at
    FROM (
      SELECT ${dag_orchestration_node.job_name} AS job_name,
             ${dag_orchestration_node.status} AS status,
             ${dag_orchestration_node.finished_at} AS finished_at,
             row_number() OVER (
               PARTITION BY ${dag_orchestration_node.job_name}
               ORDER BY ${dag_orchestration_node.finished_at} DESC NULLS LAST
             ) AS rn
      FROM ${dag_orchestration_node}
      WHERE ${dag_orchestration_node.job_name} IN (${names})
        AND ${dag_orchestration_node.status} IN (${sql.join(
          TERMINAL_FOR_HISTORY.map((status) => sql`${status}`),
          sql`, `,
        )})
    ) ranked
    WHERE rn <= 2
  `),
  );
  for (const row of successes) {
    out.set(row.job_name, { lastSuccess: asDate(row.finished_at), recent: [] });
  }
  for (const row of recent) {
    const current = out.get(row.job_name) ?? { lastSuccess: null, recent: [] };
    current.recent.push({ status: row.status, finishedAt: asDate(row.finished_at) });
    out.set(row.job_name, current);
  }
  return out;
}

async function loadBriefWatermark(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${memory_brief_note.refreshed_at})` })
    .from(memory_brief_note)
    .where(inArray(memory_brief_note.scope_key, [...REFLECTION_BRIEF_SCOPE_KEYS]));
  return asDate(row?.at);
}

function shanghaiDayStart(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${day}T00:00:00+08:00`);
}
