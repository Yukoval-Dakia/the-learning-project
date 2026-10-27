import type { Db, Tx } from '@/db/client';
import {
  type LoadTodayOvernightDigest,
  type OvernightDigest,
  loadTodayOvernightDigest,
} from '@/server/today/overnight-digest';

export type { LoadTodayOvernightDigest } from '@/server/today/overnight-digest';

const OVERNIGHT_HANDOFF_UNAVAILABLE = '夜链数据暂不可用。';

/**
 * One-line header for Copilot. Null is the same quiet-night state Today renders; degradation
 * leads the sentence so a partially failed night cannot sound like an unqualified success.
 */
function formatOvernightHandoffSentence(digest: OvernightDigest): string | null {
  if (!digest.has_overnight_activity && digest.cost.records === 0) return null;

  const facts: string[] = [];
  const runsTotal = digest.runs.reduce((sum, group) => sum + group.count, 0);
  if (runsTotal > 0) facts.push(`夜间任务 ${runsTotal} 次`);
  if (digest.note_changes_count > 0) facts.push(`笔记精炼 ${digest.note_changes_count} 次`);
  if (digest.new_proposals_count > 0) facts.push(`图谱提议 ${digest.new_proposals_count} 条`);
  if (digest.new_conjectures_count > 0) facts.push(`备课猜想 ${digest.new_conjectures_count} 条`);
  if (digest.agent_notes_count > 0) facts.push(`AI 观察 ${digest.agent_notes_count} 条`);

  if (digest.cost.records > 0)
    facts.push(`昨日 AI 费用记录 ${digest.cost.records} 条（含前台与后台，非订阅扣额）`);

  const detail = facts.length > 0 ? facts.join('，') : '记录到活动，但暂无可展开的交班明细';
  const degraded = digest.degraded_kinds.length;
  if (degraded > 0) return `${degraded} 类夜间任务降级；${detail}。`;
  return `${detail}。`;
}

/** Read the Copilot handoff sentence with its existing asynchronous failure policy. */
export function readOvernightHandoffSentence(
  db: Db | Tx,
  override?: LoadTodayOvernightDigest,
): Promise<string | null> {
  const load = override ?? loadTodayOvernightDigest;
  return load(db)
    .then(formatOvernightHandoffSentence)
    .catch((err) => {
      console.warn('[learner-state] overnight_digest_unavailable', {
        event: 'overnight_digest_unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
      return OVERNIGHT_HANDOFF_UNAVAILABLE;
    });
}
