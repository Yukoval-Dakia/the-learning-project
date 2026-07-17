import { describe, expect, it, vi } from 'vitest';

import {
  TODAY_PROPOSAL_KPI_LIMIT,
  loadTodayProposalKpiFromPages,
} from '@/server/today/proposal-kpi';

function kinds(kind: 'defer' | 'archive' | 'knowledge_edge' | 'completion', count: number) {
  return Array.from({ length: count }, () => ({ kind }));
}

describe('loadTodayProposalKpiFromPages', () => {
  it('counts actionable proposals beyond an observe-only first page', async () => {
    const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) {
        return {
          rows: kinds('defer', TODAY_PROPOSAL_KPI_LIMIT),
          next_cursor: 'page-2',
        };
      }
      return {
        rows: [...kinds('archive', 1), ...kinds('knowledge_edge', 1), ...kinds('completion', 1)],
        next_cursor: null,
      };
    });

    const result = await loadTodayProposalKpiFromPages(loadPage);

    expect(result).toMatchObject({
      total: 503,
      decision_total: 2,
      has_more: true,
      limit: TODAY_PROPOSAL_KPI_LIMIT,
      status: 'pending',
    });
    expect(result.by_kind.defer).toBe(500);
    expect(result.by_kind.archive).toBe(1);
    expect(result.by_kind.knowledge_edge).toBe(1);
    expect(result.by_kind.completion).toBe(1);
    expect(loadPage).toHaveBeenNthCalledWith(1, {
      status: 'pending',
      limit: TODAY_PROPOSAL_KPI_LIMIT,
    });
    expect(loadPage).toHaveBeenNthCalledWith(2, {
      status: 'pending',
      limit: TODAY_PROPOSAL_KPI_LIMIT,
      cursor: 'page-2',
    });
  });

  it('fails closed if a broken page loader repeats its cursor', async () => {
    const loadPage = vi.fn(async () => ({ rows: kinds('defer', 1), next_cursor: 'same' }));

    await expect(loadTodayProposalKpiFromPages(loadPage)).rejects.toThrow(
      'proposal KPI pagination repeated cursor',
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
  });
});
