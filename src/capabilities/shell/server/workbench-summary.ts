// M4-T5 (YUK-319)：工作台聚合读模型——today 重生聚合（spec M4 验收：「夜间
// 跑完，早上工作台有交班条与待审提议」）。新端点不受搬迁红线约束；KPI 口径
// 对齐旧 today 页前端逻辑（app/(app)/today/page.tsx L135-144，T7 拆除）：
//   due_count                 = /api/review/due?limit=200 rows.length
//   pending_attribution_count = /api/mistakes?limit=200 rows.filter(cause===null).length
//   knowledge_count           = /api/knowledge 树快照行数（non-archived）
// week_heat 是新聚合——旧页 WeekHeat 因无 activity 聚合端点而 OMITTED
// （page.tsx L362-366），此处补上服务端实现。

import { handleReviewDue } from '@/capabilities/practice/server/due-list';
import type { Db } from '@/db/client';
import { event, goal, knowledge, learning_session } from '@/db/schema';
import { listMistakeProjectionRows } from '@/server/records/mistakes';
import { type TodayProposalKpi, loadTodayProposalKpi } from '@/server/today/proposal-kpi';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

// 与旧 today 页一致的采样上限：KPI 是「今日量级」信号，不是精确总量。
const KPI_SAMPLE_LIMIT = 200;
const ACTIVE_SESSIONS_LIMIT = 6;

export interface WorkbenchSessionRow {
  id: string;
  status: string;
  summary_md: string | null;
  /** epoch seconds——旧 /api/learning-sessions wire 同口径 */
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  reviewed_count: number;
}

export interface WorkbenchHeatDay {
  /** BJT 日界的 YYYY-MM-DD */
  day: string;
  count: number;
}

export interface WorkbenchSummary {
  proposals: TodayProposalKpi;
  kpi: {
    due_count: number;
    pending_attribution_count: number;
    knowledge_count: number;
    // 冷启动信号（YUK-473 Slice 1）：active goal 数。0 → /today 拦截到冷开屏
    // （ColdStart hero），> 0 → 正常工作台。goal 是 cold-start openable 的锚
    // （goal/learning_item/mastery_state 三冷表之一），count active goals。
    goal_count: number;
  };
  active_sessions: WorkbenchSessionRow[];
  week_heat: WorkbenchHeatDay[];
}

async function countDue(): Promise<number> {
  // due 读模型仍是 handler 形态（handleReviewDue 内嵌 round-robin / Gate-B
  // 选择逻辑，M5 提炼出 read 函数后再换直调）；此处构造内部 Request 解析
  // rows——handler 使用全局 db（与本聚合同一连接配置），无跨库风险。
  const res = await handleReviewDue(
    new Request(`http://internal/api/review/due?limit=${KPI_SAMPLE_LIMIT}`),
  );
  if (!res.ok) {
    throw new Error(`due-list handler failed: ${res.status}`);
  }
  const body = (await res.json()) as { rows: unknown[] };
  return body.rows.length;
}

async function countPendingAttribution(db: Db): Promise<number> {
  const rows = await listMistakeProjectionRows(db, { limit: KPI_SAMPLE_LIMIT });
  return rows.filter((row) => row.cause === null).length;
}

async function countKnowledge(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return row?.count ?? 0;
}

// 冷启动信号（YUK-473 Slice 1）：active goal 数。0 → /today 渲染冷开屏拦截。
async function countActiveGoals(db: Db): Promise<number> {
  const [row] = await db.select({ c: count() }).from(goal).where(eq(goal.status, 'active'));
  return row?.c ?? 0;
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

export async function loadWorkbenchSummary(db: Db): Promise<WorkbenchSummary> {
  const [
    proposals,
    dueCount,
    pendingAttributionCount,
    knowledgeCount,
    goalCount,
    activeSessions,
    weekHeat,
  ] = await Promise.all([
    loadTodayProposalKpi(db),
    countDue(),
    countPendingAttribution(db),
    countKnowledge(db),
    countActiveGoals(db),
    listActiveSessions(db),
    loadWeekHeat(db),
  ]);
  return {
    proposals,
    kpi: {
      due_count: dueCount,
      pending_attribution_count: pendingAttributionCount,
      knowledge_count: knowledgeCount,
      goal_count: goalCount,
    },
    active_sessions: activeSessions,
    week_heat: weekHeat,
  };
}
