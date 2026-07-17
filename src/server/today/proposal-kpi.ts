import {
  type AiProposalKindT,
  aiProposalKindStrength,
  aiProposalKinds,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import {
  type ProposalInboxRow,
  type ProposalStatus,
  listProposalInboxPage,
} from '@/server/proposals/inbox';

type DbLike = Db | Tx;

export const TODAY_PROPOSAL_KPI_LIMIT = 500;

export type ProposalKindCounts = Record<AiProposalKindT, number>;

export interface TodayProposalKpi {
  /** 全部 pending proposal 记录；保留 C 档以维持事实/冷启动证据。 */
  total: number;
  /** 真正需要学习者裁决的 pending proposal；C-strength observe-only 不计入。 */
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
  rows: Pick<ProposalInboxRow, 'kind'>[],
  opts: { hasMore?: boolean; limit?: number; status?: ProposalStatus } = {},
): TodayProposalKpi {
  const byKind = emptyKindCounts();
  let decisionTotal = 0;
  for (const row of rows) {
    byKind[row.kind] += 1;
    // A 档若仍处于 pending，表示 breaker 已把它退回人审；B 档天然人审。
    // 只有 C 档是 observe-only，既无 accept applier，也没有目标 mutation。
    if (aiProposalKindStrength[row.kind] !== 'C') decisionTotal += 1;
  }
  return {
    total: rows.length,
    decision_total: decisionTotal,
    by_kind: byKind,
    has_more: opts.hasMore ?? false,
    limit: opts.limit ?? TODAY_PROPOSAL_KPI_LIMIT,
    status: opts.status ?? 'pending',
  };
}

export async function loadTodayProposalKpi(db: DbLike): Promise<TodayProposalKpi> {
  const page = await listProposalInboxPage(db, {
    status: 'pending',
    limit: TODAY_PROPOSAL_KPI_LIMIT,
  });
  return summarizeTodayProposalKpi(page.rows, {
    hasMore: page.next_cursor !== null,
    limit: TODAY_PROPOSAL_KPI_LIMIT,
    status: 'pending',
  });
}
