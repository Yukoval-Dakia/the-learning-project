// YUK-520 (A1 夜窗 digest) — overnight-digest 的**纯判定逻辑**（无 DB / 无 schema 依赖）。
//
// 从 overnight-digest.ts 抽出，让「昨夜窗口边界算 / has_overnight_activity 组合 / runs 分组」
// 三块判定可在 no-DB unit 车道单测（overnight-digest.ts 经 listNoteRefineChanges /
// proposals inbox 传递依赖 @/db/client，无法落 unit 分区；本模块零 DB import，故可）。读模型
// 仍从这里 import 同一套函数——单一真相，无漂移。范本同 effectiveness-trend-summary.ts。
//
// 红线（ADR-0035 三轴正交，同 effectiveness-trend）：本模块只做计数 / 分组 / 窗口算，绝不输出
// 任何内部校准概率（confidence / predicted_p）。digest 是只读观测面，不是反馈环。

// Asia/Shanghai 是固定 UTC+8（无 DST），所以「昨夜=BJT 前一日历日」窗口可在纯 JS 里确定性
// 计算，无需 SQL 时区换算。注意：workbench-summary.ts 的 loadWeekHeat 把日界算放 SQL 是因为
// 它在一条 generate_series 里混用 JS/SQL 日期会漂；这里全程用同一份 JS 算出的 UTC 瞬时喂给所有
// 查询（无 JS/SQL 混算），故无漂移风险，且可落 unit 测。
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OvernightWindow {
  /** 窗口起（含）——昨日 00:00 BJT，ISO-8601 UTC。 */
  from: string;
  /** 窗口止（不含）——今日 00:00 BJT，ISO-8601 UTC。 */
  to: string;
}

/**
 * 「昨夜」窗口 = Asia/Shanghai 日界的**前一日历日** [from, to)。
 *
 * 窗口口径（owner 可调，默认前一日历日）：昨日整天（BJT 00:00→24:00）。「昨日整天 vs 前夜至今」
 * 是 owner 可调口径，本期默认前一日历日——系统无 `last_visited_at`「自上次到访」锚（YUK-520
 * OUT-OF-SCOPE），故用固定昨夜窗，降级注释见 overnight-digest.ts。
 *
 * 返回 Date 对（UTC 瞬时），供读模型直接喂 drizzle gte/lt——全程同一份 JS 算的瞬时，无时区混算。
 */
export function overnightWindow(now: Date): { from: Date; to: Date } {
  // 把 now 平移进 BJT 墙钟，用 UTC getter 取 BJT 日历字段，floor 到 BJT 当日 00:00（墙钟），
  // 再减回 offset 还原成真实 UTC 瞬时；今日 00:00 BJT 往前推一天 = 昨日 00:00 BJT。
  const bjt = new Date(now.getTime() + BJT_OFFSET_MS);
  const bjtTodayMidnightWallMs = Date.UTC(
    bjt.getUTCFullYear(),
    bjt.getUTCMonth(),
    bjt.getUTCDate(),
  );
  const todayStartUtcMs = bjtTodayMidnightWallMs - BJT_OFFSET_MS;
  return {
    from: new Date(todayStartUtcMs - DAY_MS),
    to: new Date(todayStartUtcMs),
  };
}

/** 一个 task_kind 的夜间运行聚合（ai_task_runs 按 kind 卷起 + 按 status 细分）。 */
export interface OvernightRunGroup {
  task_kind: string;
  /** 该 kind 窗内 finished 的 run 总数。 */
  count: number;
  /** status → count（success / error / running 等，按窗内实际出现的 status 列）。 */
  status_breakdown: Record<string, number>;
}

/** ai_task_runs 的窗内分组原始行（一行 = 一个 (task_kind, status) 计数）。 */
export interface RunStatusCountRow {
  task_kind: string;
  status: string;
  count: number;
}

/**
 * 把 (task_kind, status, count) 扁平行卷成 per-kind 分组（count 求和 + status_breakdown）。
 * 确定性输出顺序（task_kind 升序）。纯函数，落 unit 测。
 */
export function groupRunsByKind(rows: RunStatusCountRow[]): OvernightRunGroup[] {
  const byKind = new Map<string, OvernightRunGroup>();
  for (const row of rows) {
    const group = byKind.get(row.task_kind) ?? {
      task_kind: row.task_kind,
      count: 0,
      status_breakdown: {},
    };
    group.count += row.count;
    group.status_breakdown[row.status] = (group.status_breakdown[row.status] ?? 0) + row.count;
    byKind.set(row.task_kind, group);
  }
  return Array.from(byKind.values()).sort((a, b) => a.task_kind.localeCompare(b.task_kind));
}

/** has_overnight_activity 的 5 源输入（任一 > 0 → true）。 */
export interface OvernightActivityParts {
  runs_total: number;
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
}

/**
 * 「安静夜」是一等功能态（YUK-520 红线②）：has_overnight_activity 必须**枚举全部 5 源**显式产出，
 * 与「加载中/失败」可区分——它不是缺省 falsy，而是「5 源全为 0」的明确组合。新增夜间事实源时
 * 必须在这里加一项（否则空夜判定会漏算）。
 */
export function hasOvernightActivity(parts: OvernightActivityParts): boolean {
  return (
    parts.runs_total > 0 ||
    parts.note_changes_count > 0 ||
    parts.new_proposals_count > 0 ||
    parts.new_conjectures_count > 0 ||
    parts.agent_notes_count > 0
  );
}

/** /api/workbench/overnight-digest 的 wire 形状契约（read model + web client 共用）。 */
export interface OvernightDigest {
  window: OvernightWindow;
  /**
   * 5 源任一窗内有事实 → true；全 0 → false（空夜显式信号）。UI 据此区分「空夜态」与
   * 「加载中/失败」，且空夜永不落回 ColdStart（YUK-520 红线②）。
   */
  has_overnight_activity: boolean;
  /** ai_task_runs 按 task_kind 聚合（每组带 status_breakdown）。 */
  runs: OvernightRunGroup[];
  /** 窗内 note refine apply 次数。 */
  note_changes_count: number;
  /** 窗内新 proposals 数（**不含** conjecture——后者单列，两数不重叠）。 */
  new_proposals_count: number;
  /** 窗内新 conjectures（备课台）数。 */
  new_conjectures_count: number;
  /** 窗内新 agent notes 数。 */
  agent_notes_count: number;
}
