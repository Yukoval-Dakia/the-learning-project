// readCauseJudgment(db, { knowledge_ids, as_of }) → CauseJudgmentBatch v0.
// One ranking of effective failure causes. Empty knowledge_ids is the learning
// header's newest 40 failures. A node read scans the newest 200 so other topics
// do not hide it. Unknown stays null; a finished scan of streak 0 stays 0.

import { z } from 'zod';
import { type KnowledgeSignal, knownSignal, unknownSignal } from '@/core/schema/knowledge-signal';
import type { Db, Tx } from '@/db/client';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import { effectiveCauseCategoryForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { loadKnowledgeFailureStreaks } from '@/kernel/read-models/learner-activity';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';

type DbLike = Db | Tx;

export const CAUSE_JUDGMENT_SOURCE = 'kernel/read-models/cause-judgment:readCauseJudgment' as const;

const HEADER_FAILURE_WINDOW = 40;
const NODE_FAILURE_WINDOW = 200;
const HEADER_TOP = 2;
const NODE_TOP = 3;

export const CauseJudgmentInputSchema = z.strictObject({
  knowledge_ids: z.array(z.string().trim().min(1)),
  as_of: z.date(),
});
export type CauseJudgmentInput = z.infer<typeof CauseJudgmentInputSchema>;

export type TopCause = {
  category: string;
  label: string | null;
  count: number;
  last_at: string;
};

export type CauseJudgmentItem = {
  knowledge_id: string;
  consecutive_errors: KnowledgeSignal<number>;
  top_causes: KnowledgeSignal<TopCause[]>;
};

export type RecentFailureCause = {
  at: Date;
  category: string | null;
  label: string | null;
};

export type CauseJudgmentBatch = {
  version: 'v0';
  as_of: Date;
  recent_failure_count: number;
  recent_top_causes: { category: string; count: number }[];
  recent_failures: RecentFailureCause[];
  items: CauseJudgmentItem[];
};

type RankedCause = { category: string; count: number; last_at: string };

function rankCauseCounts(
  rows: readonly { category: string | null; at: Date }[],
  limit: number,
): RankedCause[] {
  const stats = new Map<string, { count: number; last: number }>();
  for (const row of rows) {
    if (!row.category) continue;
    const at = row.at.getTime();
    const prev = stats.get(row.category);
    if (!prev) stats.set(row.category, { count: 1, last: at });
    else {
      prev.count += 1;
      if (at > prev.last) prev.last = at;
    }
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([category, stat]) => ({
      category,
      count: stat.count,
      last_at: new Date(stat.last).toISOString(),
    }));
}

export async function readCauseJudgment(
  db: DbLike,
  input: CauseJudgmentInput,
): Promise<CauseJudgmentBatch> {
  const parsed = CauseJudgmentInputSchema.parse(input);
  const ids = [...new Set(parsed.knowledge_ids)];
  const asOf = new Date(parsed.as_of.getTime());
  const failures = await getFailureAttemptsForDerivation(db, {
    limit: ids.length === 0 ? HEADER_FAILURE_WINDOW : NODE_FAILURE_WINDOW,
  });
  const attributed = failures.map((failure) => ({
    at: failure.created_at,
    category: effectiveCauseCategoryForFailureAttempt(failure),
    knowledgeIds: failure.referenced_knowledge_ids,
  }));
  const headerRows = attributed.slice(0, HEADER_FAILURE_WINDOW);
  const recentRanked = rankCauseCounts(headerRows, HEADER_TOP);
  const perNode = ids.map((id) =>
    rankCauseCounts(
      attributed.filter((row) => row.knowledgeIds.includes(id)),
      NODE_TOP,
    ),
  );
  const labelIds = [
    ...recentRanked.map((row) => row.category),
    ...perNode.flatMap((rows) => rows.map((row) => row.category)),
    ...headerRows.flatMap((row) => (row.category ? [row.category] : [])),
  ];
  let labels = new Map<string, string>();
  try {
    labels = await resolveMiscCauseLabels(db, labelIds);
  } catch {
    labels = new Map();
  }
  const labeled = (rows: RankedCause[]): TopCause[] =>
    rows.map((row) => ({ ...row, label: labels.get(row.category) ?? null }));
  let streaks = new Map<string, number>();
  let streakReason: string | null = null;
  if (ids.length > 0) {
    try {
      streaks = await loadKnowledgeFailureStreaks(db, ids);
    } catch (err) {
      if (err instanceof HostOperationNotInstalledError) throw err;
      streakReason = 'streak_component_unavailable';
    }
  }
  const items: CauseJudgmentItem[] = ids.map((id, index) => ({
    knowledge_id: id,
    consecutive_errors: streakReason
      ? unknownSignal<number>(CAUSE_JUDGMENT_SOURCE, asOf, streakReason)
      : knownSignal(streaks.get(id) ?? 0, CAUSE_JUDGMENT_SOURCE, asOf),
    top_causes: knownSignal(labeled(perNode[index] ?? []), CAUSE_JUDGMENT_SOURCE, asOf),
  }));
  return {
    version: 'v0',
    as_of: asOf,
    recent_failure_count: headerRows.length,
    recent_top_causes: recentRanked.map(({ category, count }) => ({ category, count })),
    recent_failures: headerRows.map((row) => ({
      at: row.at,
      category: row.category,
      label: row.category ? (labels.get(row.category) ?? null) : null,
    })),
    items,
  };
}
