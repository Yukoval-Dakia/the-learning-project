import {
  type AiProposalKindT,
  aiProposalKindStrength,
  aiProposalKinds,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { type ProposalStatus, countPendingProposalInboxByKind } from '@/server/proposals/inbox';

type DbLike = Db | Tx;

export const TODAY_PROPOSAL_KPI_LIMIT = 500;

export type ProposalKindCounts = Record<AiProposalKindT, number>;

export interface TodayProposalKpi {
  /** 全部 pending proposal；`has_more` 时为已安全扫描部分的下界。 */
  total: number;
  /** 真正需要学习者裁决的 pending proposal；`has_more` 时为下界，C-strength 不计入。 */
  decision_total: number;
  by_kind: ProposalKindCounts;
  has_more: boolean;
  limit: number;
  status: ProposalStatus;
}

function emptyKindCounts(): ProposalKindCounts {
  return Object.fromEntries(aiProposalKinds.map((kind) => [kind, 0])) as ProposalKindCounts;
}

export function summarizeTodayProposalKpi(
  counts: Partial<Record<AiProposalKindT, number>>,
  hasMore = false,
): TodayProposalKpi {
  const byKind = emptyKindCounts();
  let total = 0;
  let decisionTotal = 0;
  for (const kind of aiProposalKinds) {
    const count = counts[kind] ?? 0;
    byKind[kind] = count;
    total += count;
    // A 档若仍处于 pending，表示 breaker 已把它退回人审；B 档天然人审。
    // 只有 C 档是 observe-only，既无 accept applier，也没有目标 mutation。
    if (aiProposalKindStrength[kind] !== 'C') decisionTotal += count;
  }
  return {
    total,
    decision_total: decisionTotal,
    by_kind: byKind,
    // Normally exact. At the 50k candidate accident ceiling the counts are explicit lower bounds;
    // keep serving Today and surface the existing truncation signal instead of throwing a 500.
    has_more: hasMore,
    limit: TODAY_PROPOSAL_KPI_LIMIT,
    status: 'pending',
  };
}

export async function loadTodayProposalKpi(db: DbLike): Promise<TodayProposalKpi> {
  const result = await countPendingProposalInboxByKind(db);
  return summarizeTodayProposalKpi(result.byKind, result.hasMore);
}
