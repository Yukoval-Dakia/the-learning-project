// YUK-520 (A1 夜窗 digest) — overnight-digest 的**纯判定逻辑**（无 DB / 无 schema 依赖）。
//
// 从 overnight-digest.ts 抽出，让「昨夜窗口边界算 / has_overnight_activity 组合 / runs 分组」
// 三块判定可在 no-DB unit 车道单测（overnight-digest.ts 经 listNoteRefineChanges /
// proposals inbox 传递依赖 @/db/client，无法落 unit 分区；本模块零 DB import，故可）。读模型
// 仍从这里 import 同一套函数——单一真相，无漂移。范本同 effectiveness-trend-summary.ts。
//
// 红线（ADR-0035 三轴正交，同 effectiveness-trend）：本模块只做计数 / 分组 / 窗口算，绝不输出
// 任何内部校准概率（confidence / predicted_p）。digest 是只读观测面，不是反馈环。

import type {
  DegradedKind,
  OvernightRunGroup,
} from '@/server/today/overnight-digest';

export type {
  DegradedKind,
  OvernightDigest,
  OvernightRunGroup,
  OvernightWindow,
} from '@/server/today/overnight-digest';

// Asia/Shanghai 是固定 UTC+8（无 DST），所以「昨夜=BJT 前一日历日」窗口可在纯 JS 里确定性
// 计算，无需 SQL 时区换算。注意：workbench-summary.ts 的 loadWeekHeat 把日界算放 SQL 是因为
// 它在一条 generate_series 里混用 JS/SQL 日期会漂；这里全程用同一份 JS 算出的 UTC 瞬时喂给所有
// 查询（无 JS/SQL 混算），故无漂移风险，且可落 unit 测。
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

// ── YUK-580：degraded_kinds（AI 运维看门狗最小切片）──
// 范围红线：①不做成本/去重轴；②不做滚动基线回归/聚类——group-by top error 足够；
// ③不新增 schema/cron/agent；④与 YUK-576 stuck-run sweeper 正交（那边管 running 卡死，
// 这里只管 error 计数），不越界。

/**
 * 某 task_kind 在窗内被判定为「降级」的阈值——error 计数 ≥ 此值才升为一等 degraded_kinds
 * 字段。选 2 是为了滤掉单次瞬时抖动噪音（1 次 error 太常见，不值得标红打扰交班缕）。
 *
 * YUK-576：计数**只含末级逻辑失败**——查询层（overnight-digest.ts loadErrorRunRows）
 * 按 status='failure' 收且排除 finish_reason ∈ {error_retried, reconciled_stuck}
 * （重试非末次 / sweeper 收敛行都不是逻辑失败）。一次逻辑请求即使两跳全挂也只计 1，
 * 「2 个独立逻辑失败才标红」的语义不被单次用户动作打满。
 */
export const DEGRADED_KIND_ERROR_THRESHOLD = 2;

/**
 * 每个 degraded kind 最多附带几条最近 error_message 原串。选 3——同一 kind 反复出现的
 * error 通常重复度高，3 条足够定位问题模式，且避免 digest payload 过大。
 */
export const DEGRADED_KIND_SAMPLE_SIZE = 3;

/**
 * 每条 error_message 原串的截断长度（字符数）。防止单条超长堆栈/prompt 回显把 digest
 * payload 撑爆——只取前缀足够人眼判断错误类型，不追求完整堆栈。
 */
export const DEGRADED_KIND_MESSAGE_MAX_LEN = 200;

/** ai_task_runs 窗内一条 status='error' 行的精简视图（供 computeDegradedKinds 消费）。 */
export interface RunErrorRow {
  task_kind: string;
  error_message: string | null;
  /** ISO-8601 UTC，用于按新→旧排序取最近 N 条。 */
  finished_at: string;
}

/** error_message 为 null 时的占位串（导出供测试按符号断言，不重复字面量）。 */
export const DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER = '(no error_message)';

function truncateErrorMessage(msg: string): string {
  if (msg.length <= DEGRADED_KIND_MESSAGE_MAX_LEN) return msg;
  return `${msg.slice(0, DEGRADED_KIND_MESSAGE_MAX_LEN)}…`;
}

/**
 * 静默失败标红（YUK-580）：把窗内 status='error' 的原始行按 task_kind 分组，error 计数
 * ≥ DEGRADED_KIND_ERROR_THRESHOLD 的 kind 升级为 degraded_kinds 条目，附最近
 * DEGRADED_KIND_SAMPLE_SIZE 条 error_message（新→旧，按 finished_at 排序，逐条截断）。
 * 纯函数——不做成本/去重/滚动基线（YUK-580 边界①②），只做 group-by + top-N。
 */
export function computeDegradedKinds(rows: RunErrorRow[]): DegradedKind[] {
  const byKind = new Map<string, RunErrorRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.task_kind) ?? [];
    list.push(row);
    byKind.set(row.task_kind, list);
  }
  const out: DegradedKind[] = [];
  for (const [task_kind, list] of byKind) {
    if (list.length < DEGRADED_KIND_ERROR_THRESHOLD) continue;
    // 三段式比较（antisymmetric）：相等 finished_at 返回 0，交给 Array.sort 的稳定排序
    // （V8/Node 保证稳定）落回原数组序——避免同毫秒多条 error 时取样/顺序不确定。
    const sorted = [...list].sort((a, b) =>
      a.finished_at < b.finished_at ? 1 : a.finished_at > b.finished_at ? -1 : 0,
    );
    const recent_error_messages = sorted
      .slice(0, DEGRADED_KIND_SAMPLE_SIZE)
      .map((r) => truncateErrorMessage(r.error_message ?? DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER));
    out.push({ task_kind, error_count: list.length, recent_error_messages });
  }
  return out.sort((a, b) => a.task_kind.localeCompare(b.task_kind));
}
