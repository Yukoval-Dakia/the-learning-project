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
  from: string;
  to: string;
}

export interface OvernightRunGroup {
  task_kind: string;
  count: number;
  status_breakdown: Record<string, number>;
}

export interface DegradedKind {
  task_kind: string;
  error_count: number;
  recent_error_messages: string[];
}

export interface OvernightDigest {
  window: OvernightWindow;
  has_overnight_activity: boolean;
  runs: OvernightRunGroup[];
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
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
