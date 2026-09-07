import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { type ApiOperationJsonResponse, apiJson } from '@/ui/lib/api';
import { describeCosts } from '@/ui/lib/cost-presentation';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import {
  AdminLinks,
  type AdminSurfaceProps,
  ErrorCard,
  Kpi,
  LoadingCard,
  mutedTextStyle,
  sectionTitleStyle,
} from './observability-shared';

type CostResponse = ApiOperationJsonResponse<'getAdminCost'>;

function maxByCurrency(rows: Array<{ currency: string; cost: number }>): Map<string, number> {
  const maxima = new Map<string, number>();
  for (const row of rows) {
    maxima.set(row.currency, Math.max(maxima.get(row.currency) ?? 0, row.cost));
  }
  return maxima;
}

function barWidthPct(cost: number, currency: string, maxima: Map<string, number>): number {
  const max = Math.max(maxima.get(currency) ?? 0, 0.000001);
  return (cost / max) * 100;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

export function AdminCostSurface({ navigate }: AdminSurfaceProps) {
  const queryClient = useQueryClient();
  const costQ = useQuery({
    queryKey: ['admin-cost'],
    queryFn: () => apiJson<CostResponse>('/api/admin/cost?days=30'),
    refetchInterval: 60_000,
  });
  const days = costQ.data?.days ?? [];
  const byTask = costQ.data?.by_task ?? [];
  const totalCost = describeCosts(days, 4);
  const totalCalls = days.reduce((sum, row) => sum + row.calls, 0);
  const totalTokens = days.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0);
  const maxDayByCurrency = maxByCurrency(days);
  const maxTaskByCurrency = maxByCurrency(byTask);

  return (
    <main className="page wide" style={{ width: '100%', minWidth: 0 }}>
      <PageHeader
        className="[&_.page-head-actions]:min-w-0 [&_.page-head-actions]:max-w-full"
        title="Cost"
        eyebrow="ADMIN · cost ledger"
        sub="按日与任务汇总已报告、估算和历史口径金额；未知费用单列，不代表账户实际扣款。"
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--s-2)',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <AdminLinks navigate={navigate} />
          </div>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['admin-cost'] });
            }}
          >
            刷新
          </Button>
        </div>
      </PageHeader>

      {costQ.data && !costQ.error && (
        <div className="kpi-strip">
          <Kpi label="30d known subtotal" value={totalCost.amount} note="不含未知费用" />
          <Kpi label="calls" value={totalCalls} note="ledger rows" />
          <Kpi label="tokens" value={formatTokens(totalTokens)} note="in + out" />
          <Kpi label="tasks" value={byTask.length} note="task kinds" />
        </div>
      )}
      {costQ.data && !costQ.error && <p style={mutedTextStyle}>{totalCost.note}</p>}

      {costQ.isLoading && <LoadingCard label="cost" />}
      {costQ.error && <ErrorCard error={costQ.error} />}

      {costQ.data && !costQ.error && (
        <div className="admin-two-column">
          <Card pad="lg">
            <h2 style={sectionTitleStyle}>Daily trend</h2>
            <div style={barListStyle}>
              {days.map((row) => {
                const cost = describeCosts([row], 4);
                return (
                  <div key={`${row.day}:${row.currency}`} className="admin-bar-row">
                    <span style={barLabelStyle}>
                      {row.day} · {row.currency}
                    </span>
                    <span style={barTrackStyle} className="admin-bar-track">
                      <span
                        style={{
                          ...barFillStyle,
                          width: `${barWidthPct(row.cost, row.currency, maxDayByCurrency)}%`,
                        }}
                      />
                    </span>
                    <span style={barValueStyle}>{cost.amount}</span>
                    <span style={{ ...mutedTextStyle, gridColumn: '1 / -1' }}>{cost.note}</span>
                  </div>
                );
              })}
              {days.length === 0 && <p style={mutedTextStyle}>No cost rows in the window.</p>}
            </div>
          </Card>

          <Card pad="lg">
            <h2 style={sectionTitleStyle}>By task kind</h2>
            <div style={barListStyle}>
              {byTask.map((row) => {
                const cost = describeCosts([row], 4);
                return (
                  <div key={`${row.task_kind}:${row.currency}`} className="admin-bar-row">
                    <span style={barLabelStyle}>
                      {row.task_kind} · {row.currency}
                    </span>
                    <span style={barTrackStyle} className="admin-bar-track">
                      <span
                        style={{
                          ...barFillStyle,
                          width: `${barWidthPct(row.cost, row.currency, maxTaskByCurrency)}%`,
                        }}
                      />
                    </span>
                    <span style={barValueStyle}>
                      {cost.amount} · {row.calls}
                    </span>
                    <span style={{ ...mutedTextStyle, gridColumn: '1 / -1' }}>{cost.note}</span>
                  </div>
                );
              })}
              {byTask.length === 0 && <p style={mutedTextStyle}>No task cost rows yet.</p>}
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}

const barListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const barLabelStyle: CSSProperties = {
  color: 'var(--ink-2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const barTrackStyle: CSSProperties = {
  height: 8,
  background: 'var(--paper-sunk)',
  borderRadius: 'var(--r-pill)',
  overflow: 'hidden',
  border: '1px solid var(--line-soft)',
};
const barFillStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  minWidth: 2,
  background: 'var(--coral)',
  borderRadius: 'var(--r-pill)',
};
const barValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink-3)',
  fontSize: 12,
  textAlign: 'right',
};
