// Workbench aggregation read model: KPIs, active goals, and the seven-day activity heat.

import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { learnerLocalDay } from '@/core/learner-day';
import type { SteeringGoalDataT } from '@/core/schema/steering';
import { steeringDaysLeft, steeringStartsInDays } from '@/core/steering';
import type { Db } from '@/db/client';
import {
  artifact,
  event,
  goal,
  knowledge,
  learning_session,
  practice_stream_item,
  question,
  source_asset,
  source_document,
} from '@/db/schema';
import { proposalAutoApplyEnabled } from '@/kernel/proposals/auto-apply-marker';
import { listMistakeProjectionRows } from '@/kernel/read-models/mistake-projection';
import { type ColdStartState, buildColdStartState } from './cold-start-state';
import { type TodayProposalKpi, loadTodayProposalKpi } from './proposal-kpi';

// KPI sampling cap: these are magnitude signals, not exact totals.
const KPI_SAMPLE_LIMIT = 200;
const ACTIVE_SESSIONS_LIMIT = 6;
const PAST_STEERINGS_LIMIT = 10;

export interface WorkbenchSessionRow {
  id: string;
  status: string;
  summary_md: string | null;
  /** Epoch seconds, matching the learning-sessions wire. */
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  reviewed_count: number;
}

/** One active goal as the today page lists it; steering fields are null on a typed goal. */
export interface WorkbenchActiveGoal {
  id: string;
  title: string;
  instruction_md: string | null;
  learner_words: string | null;
  /** Learner-local YYYY-MM-DD days; the day counts are from today. */
  window: {
    from: string | null;
    until: string | null;
    days_left: number | null;
    starts_in_days: number | null;
  };
  /** Named knowledge in a narrowed scope, and the parts said that matched none. */
  scope: { names: string[]; unresolved: string[] };
  revise_prompt: string;
  end_prompt: string;
}

/** An arrangement said to the companion that no longer applies, newest ended first. */
export interface WorkbenchPastSteering {
  id: string;
  instruction_md: string;
  learner_words: string;
  /** Learner-local YYYY-MM-DD; null when it had no end date. */
  until: string | null;
  /** withdrawn: the learner ended it; expired: its date passed. */
  ended: 'withdrawn' | 'expired';
  /** Learner-local day it stopped applying. */
  ended_on: string;
}

export interface WorkbenchHeatDay {
  /** YYYY-MM-DD in the Asia/Shanghai day boundary. */
  day: string;
  count: number;
}

export interface WorkbenchSummary {
  proposals: TodayProposalKpi;
  kpi: {
    due_count: number;
    due_count_scope?: 'actionable_queue_sample';
    pending_attribution_count: number;
    knowledge_count: number;
    goal_count: number;
  };
  cold_start: ColdStartState;
  /** Every active goal, newest first. Empty means no current goal, not cold start. */
  active_goals: WorkbenchActiveGoal[];
  past_steerings: WorkbenchPastSteering[];
  active_sessions: WorkbenchSessionRow[];
  week_heat: WorkbenchHeatDay[];
  // Resolved in the API process, where the config snapshot is hydrated.
  auto_apply_enabled: boolean;
}

/** Practice owns the actionable review queue; the composition layer supplies its read. */
export interface WorkbenchSummaryParts {
  queryReviewDue: (db: Db, input: { limit: number }) => Promise<{ rows: readonly unknown[] }>;
}

async function countDue(db: Db, parts: WorkbenchSummaryParts): Promise<number> {
  const { rows } = await parts.queryReviewDue(db, { limit: KPI_SAMPLE_LIMIT });
  return rows.length;
}

async function countPendingAttribution(db: Db): Promise<number> {
  const rows = await listMistakeProjectionRows(db, { limit: KPI_SAMPLE_LIMIT });
  return rows.filter((row) => row.cause === null).length;
}

// Subject roots (`seed:<subject>:root`) are written by every install's migrate, not by the
// learner, so they must not count as learner knowledge for the cold-start decision.
async function countKnowledge(db: Db): Promise<{ all: number; learner: number }> {
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      learner: sql<number>`(count(*) filter (where ${knowledge.id} not like 'seed:%:root'))::int`,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return { all: row?.all ?? 0, learner: row?.learner ?? 0 };
}

interface PersistedColdStartPresence extends Record<string, unknown> {
  goal_history: boolean;
  question: boolean;
  source_material: boolean;
  artifact: boolean;
  practice_stream: boolean;
  learning_session: boolean;
  user_event: boolean;
}

async function loadPersistedColdStartPresence(db: Db): Promise<PersistedColdStartPresence> {
  // EXISTS keeps this constant-time: cold start needs presence, not exact counts.
  const rows = await db.execute<PersistedColdStartPresence>(sql`
    select
      exists(select 1 from ${goal}) as goal_history,
      exists(select 1 from ${question}) as question,
      (
        exists(select 1 from ${source_document})
        or exists(select 1 from ${source_asset})
      ) as source_material,
      exists(select 1 from ${artifact} where ${artifact.archived_at} is null) as artifact,
      exists(select 1 from ${practice_stream_item}) as practice_stream,
      exists(select 1 from ${learning_session}) as learning_session,
      exists(select 1 from ${event} where ${event.actor_kind} = 'user') as user_event
  `);
  const row = [...rows][0];
  return (
    row ?? {
      goal_history: false,
      question: false,
      source_material: false,
      artifact: false,
      practice_stream: false,
      learning_session: false,
      user_event: false,
    }
  );
}

/** How a goal is named back to the learner: the companion's restatement for a said one. */
function goalLabel(title: string, steering: SteeringGoalDataT | null): string {
  return steering?.instruction_md ?? title;
}

async function loadActiveGoals(db: Db, today: string): Promise<WorkbenchActiveGoal[]> {
  const rows = await db
    .select({
      id: goal.id,
      title: goal.title,
      scope_mode: goal.scope_mode,
      scope_knowledge_ids: goal.scope_knowledge_ids,
      effective_from: goal.effective_from,
      effective_until: goal.effective_until,
      steering: goal.steering,
    })
    .from(goal)
    .where(eq(goal.status, 'active'))
    // id 降序作确定性 tie-break——同 created_at（同批种子/同秒创建）时选取稳定，不随 reload 漂移。
    .orderBy(desc(goal.created_at), desc(goal.id));
  // A subject-wide goal's scope is the whole subject, which its title already says; only a
  // hand-narrowed scope is worth naming.
  const scopeIds = [
    ...new Set(
      rows.flatMap((row) => (row.scope_mode === 'explicit' ? (row.scope_knowledge_ids ?? []) : [])),
    ),
  ];
  const names = new Map<string, string>();
  if (scopeIds.length > 0) {
    const found = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(and(inArray(knowledge.id, scopeIds), isNull(knowledge.archived_at)));
    for (const row of found) names.set(row.id, row.name);
  }
  return rows.map((row) => {
    const steering = row.steering ?? null;
    const label = goalLabel(row.title, steering);
    return {
      id: row.id,
      title: row.title,
      instruction_md: steering?.instruction_md ?? null,
      learner_words: steering?.learner_words ?? null,
      window: {
        from: row.effective_from,
        until: row.effective_until,
        days_left: steeringDaysLeft(row.effective_until, today),
        starts_in_days: steeringStartsInDays(row.effective_from, today),
      },
      scope: {
        names:
          row.scope_mode === 'explicit'
            ? (row.scope_knowledge_ids ?? []).flatMap((id) => names.get(id) ?? [])
            : [],
        unresolved: steering?.scope_unresolved ?? [],
      },
      // Both open the companion with the sentence already typed; the learner finishes or sends
      // it, and the companion makes the change through the same tool that recorded it.
      revise_prompt: `把「${label}」改成：`,
      // 「撤回」 alone read as undoing the last change once a revised restatement named that
      // change (11-08 real turn moved the date back instead of ending it): say 取消, as an exam
      // being called off is said.
      end_prompt: `这个安排取消了，以后不用再按它安排：「${label}」`,
    };
  });
}

async function loadPastSteerings(db: Db): Promise<WorkbenchPastSteering[]> {
  // The day it ended is the status change that ended it. The row's updated_at moves with any
  // later write, such as a knowledge merge rewriting the scope of an ended goal.
  const endedAt = sql<Date>`(
    select max(${event.created_at}) from ${event}
    where ${event.subject_kind} = 'goal'
      and ${event.subject_id} = ${goal.id}
      and ${event.action} = 'experimental:goal_status_update'
      and ${event.payload}->>'status' = ${goal.status}
  )`.mapWith(goal.updated_at);
  const rows = await db
    .select({
      id: goal.id,
      status: goal.status,
      effective_until: goal.effective_until,
      steering: goal.steering,
      ended_at: endedAt,
      updated_at: goal.updated_at,
    })
    .from(goal)
    .where(and(isNotNull(goal.steering), ne(goal.status, 'active')))
    .orderBy(desc(sql`coalesce(${endedAt}, ${goal.updated_at})`), desc(goal.id))
    .limit(PAST_STEERINGS_LIMIT);
  return rows.flatMap((row) =>
    row.steering
      ? [
          {
            id: row.id,
            instruction_md: row.steering.instruction_md,
            learner_words: row.steering.learner_words,
            until: row.effective_until,
            // The expiry sweep marks a passed window done; ending it by word leaves it dormant.
            ended: row.status === 'done' ? ('expired' as const) : ('withdrawn' as const),
            ended_on: learnerLocalDay(row.ended_at ?? row.updated_at),
          },
        ]
      : [],
  );
}

async function listActiveSessions(db: Db): Promise<WorkbenchSessionRow[]> {
  // 轻量交班条：最近 review 会话 + reviewed_count，不照搬旧
  // /api/learning-sessions 的完整 stats（rating_counts / knowledge_touched
  // 等 T6 工作台不渲染，第二实例需求出现再扩）。
  const sessions = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.type, 'review'))
    .orderBy(desc(learning_session.started_at))
    .limit(ACTIVE_SESSIONS_LIMIT);
  if (sessions.length === 0) return [];

  const counts = await db
    .select({ session_id: event.session_id, count: sql<number>`count(*)::int` })
    .from(event)
    .where(
      and(
        inArray(
          event.session_id,
          sessions.map((s) => s.id),
        ),
        eq(event.action, 'review'),
        eq(event.subject_kind, 'question'),
      ),
    )
    .groupBy(event.session_id);
  const countBySession = new Map(counts.map((c) => [c.session_id, c.count]));

  return sessions.map((s) => {
    const endedAt = s.ended_at ?? (s.status === 'started' ? new Date() : null);
    return {
      id: s.id,
      status: s.status,
      summary_md: s.summary_md,
      started_at: Math.floor(s.started_at.getTime() / 1000),
      ended_at: s.ended_at ? Math.floor(s.ended_at.getTime() / 1000) : null,
      duration_ms: endedAt ? endedAt.getTime() - s.started_at.getTime() : null,
      reviewed_count: countBySession.get(s.id) ?? 0,
    };
  });
}

async function loadWeekHeat(db: Db): Promise<WorkbenchHeatDay[]> {
  // 近 7 天（含今天）按 BJT 日界分天 event 计数——generate_series 在 SQL 侧
  // 补零天，避免 JS/SQL 两套时区换算口径漂移；join 条件带 created_at 预过滤
  // （宽放 8 天）避免对全表做日期时区转换。
  const rows = await db.execute<{ day: string; count: number }>(sql`
    with days as (
      select generate_series(
        (now() at time zone 'Asia/Shanghai')::date - 6,
        (now() at time zone 'Asia/Shanghai')::date,
        interval '1 day'
      )::date as day
    )
    select days.day::text as day, count(${event.id})::int as count
    from days
    left join ${event}
      on ${event.created_at} >= now() - interval '8 days'
      and (${event.created_at} at time zone 'Asia/Shanghai')::date = days.day
    group by days.day
    order by days.day
  `);
  return [...rows].map((row) => ({ day: row.day, count: row.count }));
}

export async function loadWorkbenchSummary(
  db: Db,
  parts: WorkbenchSummaryParts,
): Promise<WorkbenchSummary> {
  const [
    proposals,
    dueCount,
    pendingAttributionCount,
    knowledgeCount,
    activeGoals,
    pastSteerings,
    activeSessions,
    weekHeat,
    persistedPresence,
  ] = await Promise.all([
    loadTodayProposalKpi(db),
    countDue(db, parts),
    countPendingAttribution(db),
    countKnowledge(db),
    loadActiveGoals(db, learnerLocalDay(new Date())),
    loadPastSteerings(db),
    listActiveSessions(db),
    loadWeekHeat(db),
    loadPersistedColdStartPresence(db),
  ]);
  const coldStart = buildColdStartState({
    active_goal: activeGoals.length > 0,
    goal_history: persistedPresence.goal_history,
    knowledge: knowledgeCount.learner > 0,
    question: persistedPresence.question,
    source_material: persistedPresence.source_material,
    artifact: persistedPresence.artifact,
    review_due: dueCount > 0,
    pending_attribution: pendingAttributionCount > 0,
    practice_stream: persistedPresence.practice_stream,
    proposal: proposals.total > 0,
    learning_session: persistedPresence.learning_session,
    user_event: persistedPresence.user_event,
  });
  return {
    proposals,
    kpi: {
      due_count: dueCount,
      due_count_scope: 'actionable_queue_sample',
      pending_attribution_count: pendingAttributionCount,
      knowledge_count: knowledgeCount.all,
      goal_count: activeGoals.length,
    },
    cold_start: coldStart,
    active_goals: activeGoals,
    past_steerings: pastSteerings,
    active_sessions: activeSessions,
    week_heat: weekHeat,
    auto_apply_enabled: proposalAutoApplyEnabled(),
  };
}
