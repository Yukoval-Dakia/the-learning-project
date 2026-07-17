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
  /** 全部 pending proposal 记录的未截断总数；保留 C 档以维持事实/冷启动证据。 */
  total: number;
  /** 真正需要学习者裁决的 pending proposal；C-strength observe-only 不计入。 */
  decision_total: number;
  by_kind: ProposalKindCounts;
  has_more: boolean;
  limit: number;
  status: ProposalStatus;
}

interface ProposalKpiPage {
  rows: Pick<ProposalInboxRow, 'kind'>[];
  next_cursor: string | null;
}

export type ProposalKpiPageLoader = (opts: {
  status: ProposalStatus;
  limit: number;
  cursor?: string;
}) => Promise<ProposalKpiPage>;

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

/**
 * 穿透 pending 投影的全部 cursor 页，计算未截断 KPI。不能只看首 500 行：排序首批可能全是
 * C-strength，而后续仍有真正待人审的 A/B 行。`has_more` 记录本次读取是否跨过首个分页，
 * `limit` 是内部页大小，不是 total 的截断上限。
 */
export async function loadTodayProposalKpiFromPages(
  loadPage: ProposalKpiPageLoader,
): Promise<TodayProposalKpi> {
  const aggregate = summarizeTodayProposalKpi([], {
    limit: TODAY_PROPOSAL_KPI_LIMIT,
    status: 'pending',
  });
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await loadPage({
      status: 'pending',
      limit: TODAY_PROPOSAL_KPI_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const pageSummary = summarizeTodayProposalKpi(page.rows);
    aggregate.total += pageSummary.total;
    aggregate.decision_total += pageSummary.decision_total;
    for (const kind of aiProposalKinds) {
      aggregate.by_kind[kind] += pageSummary.by_kind[kind];
    }

    const nextCursor = page.next_cursor;
    if (!nextCursor) break;
    aggregate.has_more = true;
    if (seenCursors.has(nextCursor)) {
      throw new Error('proposal KPI pagination repeated cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return aggregate;
}

export async function loadTodayProposalKpi(db: DbLike): Promise<TodayProposalKpi> {
  return loadTodayProposalKpiFromPages((opts) => listProposalInboxPage(db, opts));
}
