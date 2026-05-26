import { type AiProposalKindT, aiProposalKinds } from '@/core/schema/proposal';
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
  total: number;
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
  for (const row of rows) {
    byKind[row.kind] += 1;
  }
  return {
    total: rows.length,
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
