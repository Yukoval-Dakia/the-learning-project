// Shared overnight facts and loader for Today, Start and Copilot.
// The shared read model owns aggregation plus the one-line handoff sentence and
// its failure policy (degrade to a fixed unavailable sentence, never throw).
// Query and cost readers load lazily after the caller supplies its clock and DB.

import type { ProviderCostWindow } from '@/core/schema/cost-observation';
import type { Db, Tx } from '@/db/client';
import { overnightWindowDays } from './overnight-digest-summary';

type DbLike = Db | Tx;

export interface OvernightWindow {
  /**
   * Window start (inclusive), ISO-8601 UTC: the day of the learner's last activity,
   * never later than yesterday 00:00 BJT and never earlier than the 14-day cap.
   */
  from: string;
  /** Window end (exclusive): today 00:00 BJT, ISO-8601 UTC. */
  to: string;
}

/** Runs for one task_kind in the window, rolled up by status. */
export interface OvernightRunGroup {
  task_kind: string;
  /** Finished runs in the window. */
  count: number;
  /** Status → count for statuses that actually appear in the window. */
  status_breakdown: Record<string, number>;
}

/** A task_kind marked degraded: total errors plus degraded scans, plus recent samples. */
export interface DegradedKind {
  task_kind: string;
  /** Total errors and degraded scans in the window, not just the messages shown below. */
  error_count: number;
  /** Most recent first; the aggregator truncates long strings. */
  recent_error_messages: string[];
}

/** Five-source overnight facts shared by Today and Copilot. */
export interface OvernightDigest {
  window: OvernightWindow;
  /** All accounting activity in the window; not night-cron-only or billing quota. */
  cost: ProviderCostWindow;
  /** Any of the five sources has a fact; false is an explicit quiet night, never ColdStart. */
  has_overnight_activity: boolean;
  runs: OvernightRunGroup[];
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
  /** Non-empty implies has_overnight_activity; the reverse does not hold. */
  degraded_kinds: DegradedKind[];
}

export type LoadTodayOvernightDigest = (db: DbLike, now?: Date) => Promise<OvernightDigest>;

const OVERNIGHT_HANDOFF_UNAVAILABLE = '夜链数据暂不可用。';
/** Whole days the digest covers; 1 means the ordinary "last night" window. */
export function overnightDigestDays(window: OvernightWindow): number {
  return overnightWindowDays({ from: new Date(window.from), to: new Date(window.to) });
}

/**
 * One-line handoff for prompt/header surfaces. Null is the same quiet-night state
 * Today renders; degradation leads the sentence so a partially failed night cannot
 * sound like an unqualified success.
 */
export function formatOvernightHandoffSentence(digest: OvernightDigest): string | null {
  if (!digest.has_overnight_activity && digest.cost.records === 0) return null;

  const days = overnightDigestDays(digest.window);
  const absence = days > 1 ? `你不在的这 ${days} 天` : null;
  const facts: string[] = [];
  const runsTotal = digest.runs.reduce((sum, group) => sum + group.count, 0);
  if (runsTotal > 0) facts.push(`夜间任务 ${runsTotal} 次`);
  if (digest.note_changes_count > 0) facts.push(`笔记精炼 ${digest.note_changes_count} 次`);
  if (digest.new_proposals_count > 0) facts.push(`图谱提议 ${digest.new_proposals_count} 条`);
  if (digest.new_conjectures_count > 0) facts.push(`备课猜想 ${digest.new_conjectures_count} 条`);
  if (digest.agent_notes_count > 0) facts.push(`AI 观察 ${digest.agent_notes_count} 条`);

  if (digest.cost.records > 0)
    facts.push(
      `${absence ? '这几天' : '昨日'} AI 费用记录 ${digest.cost.records} 条（含前台与后台，非订阅扣额）`,
    );

  const detail = facts.length > 0 ? facts.join('，') : '记录到活动，但暂无可展开的交班明细';
  const lead = absence ? `${absence}里，` : '';
  const degraded = digest.degraded_kinds.length;
  if (degraded > 0) return `${lead}${degraded} 类夜间任务降级；${detail}。`;
  return `${lead}${detail}。`;
}

/** Read the handoff sentence with its existing asynchronous failure policy. */
export function readOvernightHandoffSentence(
  db: DbLike,
  override?: LoadTodayOvernightDigest,
): Promise<string | null> {
  const load = override ?? loadTodayOvernightDigest;
  return load(db)
    .then(formatOvernightHandoffSentence)
    .catch((err) => {
      console.warn('[learner-context] overnight_digest_unavailable', {
        event: 'overnight_digest_unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
      return OVERNIGHT_HANDOFF_UNAVAILABLE;
    });
}

/** Canonical read point for the previous BJT calendar day's digest. */
export const loadTodayOvernightDigest: LoadTodayOvernightDigest = async (db, now = new Date()) => {
  const [{ loadOvernightDigest }, { readProviderCostWindow }] = await Promise.all([
    import('./overnight-digest-query'),
    import('./provider-cost-projection'),
  ]);
  return loadOvernightDigest(db, now, readProviderCostWindow);
};
