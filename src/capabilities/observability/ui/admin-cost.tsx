import { apiJson } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import {
  AdminLinks,
  type AdminSurfaceProps,
  ErrorCard,
  Kpi,
  LoadingCard,
  currencySymbol,
  formatMoney,
  mutedTextStyle,
  sectionTitleStyle,
} from './observability-shared';

interface CostResponse {
  days_window: number;
  days: Array<{
    day: string;
    currency: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    calls: number;
  }>;
  by_task: Array<{
    task_kind: string;
    currency: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    calls: number;
  }>;
}

function sumByCurrency(rows: Array<{ currency: string; cost: number }>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cost);
  }
  return totals;
}

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

function formatMoneyByCurrency(totals: Map<string, number>): string {
  if (totals.size === 0) return '$0.0000';
  return [...totals.entries()]
    .map(([currency, value]) => `${currencySymbol(currency)}${value.toFixed(4)}`)
    .join(' · ');
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
  const totalByCurrency = sumByCurrency(days);
  const totalCalls = days.reduce((sum, row) => sum + row.calls, 0);
  const totalTokens = days.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0);
  const maxDayByCurrency = maxByCurrency(days);
  const maxTaskByCurrency = maxByCurrency(byTask);

  return (
    <main className="page wide">
      <PageHeader
        title="Cost"
        eyebrow="ADMIN · cost ledger"
        sub="按日与 task kind 聚合 `cost_ledger`，用于观察预算趋势和高成本任务。"
      >
        <AdminLinks navigate={navigate} />
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin-cost'] });
          }}
        >
          刷新
        </Button>
      </PageHeader>

      <div className="kpi-strip">
        <Kpi
          label="30d spend"
          value={formatMoneyByCurrency(totalByCurrency)}
          note={`${days.length} rows`}
        />
        <Kpi label="calls" value={totalCalls} note="ledger rows" />
        <Kpi label="tokens" value={formatTokens(totalTokens)} note="in + out" />
        <Kpi label="tasks" value={byTask.length} note="task kinds" />
      </div>

      {costQ.isLoading && <LoadingCard label="cost" />}
      {costQ.error && <ErrorCard error={costQ.error} />}

      {costQ.data && (
        <div className="admin-two-column">
          <Card pad="lg">
            <h2 style={sectionTitleStyle}>Daily trend</h2>
            <div style={barListStyle}>
              {days.map((row) => (
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
                  <span style={barValueStyle}>{formatMoney(row.cost, row.currency)}</span>
                </div>
              ))}
              {days.length === 0 && <p style={mutedTextStyle}>No cost rows in the window.</p>}
            </div>
          </Card>

          <Card pad="lg">
            <h2 style={sectionTitleStyle}>By task kind</h2>
            <div style={barListStyle}>
              {byTask.map((row) => (
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
                    {formatMoney(row.cost, row.currency)} · {row.calls}
                  </span>
                </div>
              ))}
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
