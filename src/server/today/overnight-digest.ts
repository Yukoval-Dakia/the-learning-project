// YUK-354 — package-neutral Today/Copilot overnight handoff contract.
//
// The shell capability still owns the five-source aggregation implementation, but neither
// consumer reaches into that package. This facade is the single server-side read point:
// Today's HTTP route and Copilot's learner-state projection both call the same loader and
// share the same quiet/degraded semantics. The dynamic import keeps this contract pure at
// module-load time and avoids pulling shell's DB graph into no-DB unit tests.

import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

export interface OvernightWindow {
  /** 窗口起（含）——昨日 00:00 BJT，ISO-8601 UTC。 */
  from: string;
  /** 窗口止（不含）——今日 00:00 BJT，ISO-8601 UTC。 */
  to: string;
}

/** 一个 task_kind 的夜间运行聚合（ai_task_runs 按 kind 卷起 + 按 status 细分）。 */
export interface OvernightRunGroup {
  task_kind: string;
  /** 该 kind 窗内 finished 的 run 总数。 */
  count: number;
  /** status → count（success / failure / running 等，按窗内实际出现的 status 列）。 */
  status_breakdown: Record<string, number>;
}

/** 一个被判定为「降级」的 task_kind：error 计数 + 最近错误样本。 */
export interface DegradedKind {
  task_kind: string;
  /** 窗内该 kind 的 error 总计数（不止 recent_error_messages 展示的那几条）。 */
  error_count: number;
  /** 最近错误原串（新→旧排序，超长已由聚合层截断）。 */
  recent_error_messages: string[];
}

/** Today 与 Copilot 共用的昨夜五源事实契约。 */
export interface OvernightDigest {
  window: OvernightWindow;
  /**
   * 5 源任一窗内有事实 → true；全 0 → false。空夜是显式状态，绝不回退为 ColdStart。
   */
  has_overnight_activity: boolean;
  runs: OvernightRunGroup[];
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
  /**
   * 静默失败标红列表。非空必然蕴含 has_overnight_activity=true；反向不成立。
   */
  degraded_kinds: DegradedKind[];
}

export type LoadTodayOvernightDigest = (db: DbLike, now?: Date) => Promise<OvernightDigest>;

export const OVERNIGHT_HANDOFF_UNAVAILABLE = '夜链数据暂不可用。';

/**
 * Canonical server-side read point for the fixed previous-calendar-day BJT digest.
 * The implementation remains owned by shell; this facade is the public aggregation boundary.
 */
export const loadTodayOvernightDigest: LoadTodayOvernightDigest = async (db, now) => {
  const { loadOvernightDigest } = await import('@/capabilities/shell/server/overnight-digest');
  return loadOvernightDigest(db, now);
};

/**
 * Deterministic one-line projection for Copilot's session-anchored learner-state header.
 * null is the same explicit quiet-night state rendered by Today. Degradation leads the sentence
 * so a partially failed night cannot be narrated as an unqualified success.
 */
export function formatOvernightHandoffSentence(digest: OvernightDigest): string | null {
  if (!digest.has_overnight_activity) return null;

  const facts: string[] = [];
  const runsTotal = digest.runs.reduce((sum, group) => sum + group.count, 0);
  if (runsTotal > 0) facts.push(`夜间任务 ${runsTotal} 次`);
  if (digest.note_changes_count > 0) facts.push(`笔记精炼 ${digest.note_changes_count} 次`);
  if (digest.new_proposals_count > 0) facts.push(`图谱提议 ${digest.new_proposals_count} 条`);
  if (digest.new_conjectures_count > 0) facts.push(`备课猜想 ${digest.new_conjectures_count} 条`);
  if (digest.agent_notes_count > 0) facts.push(`AI 观察 ${digest.agent_notes_count} 条`);

  const detail = facts.length > 0 ? facts.join('，') : '记录到活动，但暂无可展开的交班明细';
  const degraded = digest.degraded_kinds.length;
  if (degraded > 0) return `${degraded} 类夜间任务降级；${detail}。`;
  return `${detail}。`;
}
