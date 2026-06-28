// YUK-520 (A1 夜窗 digest) — overnight-digest 只读读模型。把**昨夜窗口**内五个夜间事实源的产出
// 聚成一个 digest payload，供 /today 的最小交班缕消费（「昨夜 AI 替你做了什么」）。范本同
// effectiveness-trend.ts（纯 drizzle 读 + 纯 summary helpers 抽到单独文件落 unit 测）。
//
// 窗口口径：「昨夜」= Asia/Shanghai 日界的**前一日历日**（owner 可调，默认前一日历日）。窗口算在
// overnightWindow（纯 JS，BJT 固定 UTC+8）。降级注释（YUK-520 OUT-OF-SCOPE）：系统无
// `last_visited_at`「自上次到访」锚，故用固定昨夜窗，不做「自上次访问以来」窗。
//
// 红线（YUK-520）：① 纯读绝不写库（evidence-first）；② has_overnight_activity 显式产出——「安静
// 夜」是一等态，必须与「加载中/失败」可区分（见 hasOvernightActivity）；③ 三轴正交——绝不写回
// mastery_state / item_calibration / FSRS；④ prep-desk confidence/predicted_p 等内部校准数永不过
// wire（只取 count，不取概率）；⑤ additive——不改既有读模型。只读现有列，零 schema 变更（故不触
// audit:schema / audit:draft-status）。
//
// 五个夜间事实源（has_overnight_activity 枚举全部）：
//   1. ai_task_runs —— 按 finished_at 时间窗（不假设 FK 完整性，loose coupling），按 task_kind 聚合
//      count + status_breakdown。finished_at 可空，gte/lt 比较天然排除 NULL。
//   2. note refine changes —— listNoteRefineChanges（窗内 count）。
//   3. agent notes —— 窗内新 experimental:agent_note 事件 count。
//   4. proposals —— 窗内新 proposals（不含 conjecture）count。
//   5. prep-desk conjectures —— 窗内新 conjectures count。

import { listNoteRefineChanges } from '@/capabilities/notes/server/note-refine-apply';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';
import { countProposalsInWindow } from '@/server/proposals/inbox';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import {
  type OvernightDigest,
  type RunStatusCountRow,
  groupRunsByKind,
  hasOvernightActivity,
  overnightWindow,
} from './overnight-digest-summary';

// 向后兼容：重导出纯模块的公共类型 / 纯函数，既有 import 路径单一。
export type {
  OvernightDigest,
  OvernightRunGroup,
  OvernightWindow,
} from './overnight-digest-summary';
export { overnightWindow } from './overnight-digest-summary';

type DbLike = Db | Tx;

// agent note 事实源谓词（与 agency/server/notes.ts 的 readAllAgentNotes 同口径：
// action='experimental:agent_note' + subject_kind='query'）。这里**故意不复用**
// readAllAgentNotes——它带 expires_at>now 过滤 + limit 20，做的是「当前未过期、给 UI 注入」的
// 读；digest 要的是「昨夜窗内 created 了几条」的历史窗计数（含此后已过期的），两者口径不同，故走
// 直接窗内 count。
async function countAgentNotesInWindow(db: DbLike, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:agent_note'),
        eq(event.subject_kind, 'query'),
        gte(event.created_at, from),
        lt(event.created_at, to),
      ),
    );
  return row?.c ?? 0;
}

// ai_task_runs 窗内分组：按 finished_at ∈ [from, to) 过滤（finished_at 可空，gte/lt 天然排除
// 未完成的 NULL 行 → 只聚「昨夜跑完的」），按 (task_kind, status) 分组取 count。扁平行交给纯函数
// groupRunsByKind 卷成 per-kind。
async function loadRunRows(db: DbLike, from: Date, to: Date): Promise<RunStatusCountRow[]> {
  const rows = await db
    .select({
      task_kind: ai_task_runs.task_kind,
      status: ai_task_runs.status,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(ai_task_runs)
    .where(and(gte(ai_task_runs.finished_at, from), lt(ai_task_runs.finished_at, to)))
    .groupBy(ai_task_runs.task_kind, ai_task_runs.status);
  return rows.map((r) => ({ task_kind: r.task_kind, status: r.status, count: r.count }));
}

// note refine apply 窗内 count——复用 listNoteRefineChanges（既有读路径，单一真相）。它只接
// since（无上界），故传 since=from 后在 JS 里裁到 < to。单用户工具 + 1 天窗，行数有界。
async function countNoteChangesInWindow(db: DbLike, from: Date, to: Date): Promise<number> {
  const rows = await listNoteRefineChanges(db, { since: from });
  return rows.filter((r) => r.created_at < to).length;
}

/**
 * 昨夜 digest 读模型。聚五个夜间事实源到一个 payload，纯读零写（红线①③）。
 * has_overnight_activity 由五源 count 显式组合（红线②）；内部校准概率永不进 payload（红线④）。
 *
 * `now` 可注入（默认 new Date()）——仅为让 db 测确定性地相对窗口播种，路由仍以 `loadOvernightDigest(db)`
 * 调用（窗口口径不变）。同 research_meeting_nightly 的 deps.now 先例。
 */
export async function loadOvernightDigest(
  db: DbLike,
  now: Date = new Date(),
): Promise<OvernightDigest> {
  const { from, to } = overnightWindow(now);

  const [runRows, noteChangesCount, agentNotesCount, proposalCounts] = await Promise.all([
    loadRunRows(db, from, to),
    countNoteChangesInWindow(db, from, to),
    countAgentNotesInWindow(db, from, to),
    countProposalsInWindow(db, { from, to }),
  ]);

  const runs = groupRunsByKind(runRows);
  const runsTotal = runs.reduce((acc, g) => acc + g.count, 0);
  // proposals 与 conjectures 不重叠：new_proposals = 全部 proposals − conjectures 子集。
  const newProposalsCount = proposalCounts.total - proposalCounts.conjectures;
  const newConjecturesCount = proposalCounts.conjectures;

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    has_overnight_activity: hasOvernightActivity({
      runs_total: runsTotal,
      note_changes_count: noteChangesCount,
      new_proposals_count: newProposalsCount,
      new_conjectures_count: newConjecturesCount,
      agent_notes_count: agentNotesCount,
    }),
    runs,
    note_changes_count: noteChangesCount,
    new_proposals_count: newProposalsCount,
    new_conjectures_count: newConjecturesCount,
    agent_notes_count: agentNotesCount,
  };
}
