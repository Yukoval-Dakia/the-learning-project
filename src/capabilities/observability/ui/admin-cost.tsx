import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { describeCosts } from '@/ui/lib/cost-presentation';
import { Button } from '@/ui-next/public';
import { type AdminReadClient, httpAdminClient } from './admin-client';
import {
  ADMIN_LINKS,
  AdminError,
  AdminFrame,
  AdminHead,
  AdminKpi,
  AdminKpis,
  AdminLoading,
  AdminNav,
  AdminPanel,
} from './admin-frame';
import type { AdminSurfaceProps } from './observability-shared';

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

export function AdminCostSurface({
  navigate,
  client = httpAdminClient,
}: AdminSurfaceProps & { client?: AdminReadClient }) {
  const queryClient = useQueryClient();
  const costQ = useQuery({
    queryKey: ['admin-cost'],
    queryFn: () => client.getCost({ days: '30' }),
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
    <AdminFrame>
      <AdminNav links={ADMIN_LINKS} current="/admin/cost" navigate={navigate} />
      <AdminHead
        kicker="ADMIN · cost ledger"
        title="Cost"
        lead="按日与任务汇总已报告、估算和历史口径金额；未知费用单列，不代表账户实际扣款。"
        actions={
          <Button
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['admin-cost'] });
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </Button>
        }
      />

      {costQ.data && !costQ.error && (
        <AdminKpis>
          <AdminKpi label="30d known subtotal" value={totalCost.amount} note="不含未知费用" />
          <AdminKpi label="calls" value={totalCalls} note="ledger rows" />
          <AdminKpi label="tokens" value={formatTokens(totalTokens)} note="in + out" />
          <AdminKpi label="tasks" value={byTask.length} note="task kinds" />
        </AdminKpis>
      )}
      {costQ.data && !costQ.error && <p className="adm-note">{totalCost.note}</p>}

      {costQ.isLoading && <AdminLoading label="cost 加载中" />}
      {costQ.error && <AdminError error={costQ.error} />}

      {costQ.data && !costQ.error && (
        <div className="adm-split">
          <AdminPanel id="adm-cost-days" title="Daily trend">
            <ul className="adm-bars">
              {days.map((row) => {
                const cost = describeCosts([row], 4);
                return (
                  <li key={`${row.day}:${row.currency}`} className="adm-bar-row">
                    <span className="adm-bar-label">
                      {row.day} · {row.currency}
                    </span>
                    <span className="adm-bar-track">
                      <span
                        className="adm-bar-fill"
                        style={{
                          width: `${barWidthPct(row.cost, row.currency, maxDayByCurrency)}%`,
                        }}
                      />
                    </span>
                    <span className="adm-bar-value">{cost.amount}</span>
                    <span className="adm-bar-note">{cost.note}</span>
                  </li>
                );
              })}
            </ul>
            {days.length === 0 && <p className="adm-empty">No cost rows in the window.</p>}
          </AdminPanel>

          <AdminPanel id="adm-cost-tasks" title="By task kind">
            <ul className="adm-bars">
              {byTask.map((row) => {
                const cost = describeCosts([row], 4);
                return (
                  <li key={`${row.task_kind}:${row.currency}`} className="adm-bar-row">
                    <span className="adm-bar-label">
                      {row.task_kind} · {row.currency}
                    </span>
                    <span className="adm-bar-track">
                      <span
                        className="adm-bar-fill"
                        style={{
                          width: `${barWidthPct(row.cost, row.currency, maxTaskByCurrency)}%`,
                        }}
                      />
                    </span>
                    <span className="adm-bar-value">
                      {cost.amount} · {row.calls}
                    </span>
                    <span className="adm-bar-note">{cost.note}</span>
                  </li>
                );
              })}
            </ul>
            {byTask.length === 0 && <p className="adm-empty">No task cost rows yet.</p>}
          </AdminPanel>
        </div>
      )}
    </AdminFrame>
  );
}
