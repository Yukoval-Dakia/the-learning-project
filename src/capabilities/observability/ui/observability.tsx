// M5-T4b (YUK-321) — admin 三页（Runs/Cost/Failures）迁 observability 包，
// SPA 路由 /admin/*。等价平移：视觉/行为与旧 src/ui/admin 版一致，next/link
// 换 navigate prop（capability ui 不 import 路由库——web/src/router.tsx 规则）。
//
// Phase-deferred（壳形态决策点）：设计真理源
// docs/design/loom-refresh/project/app.jsx:106-114 裁决「admin is a separate
// shell — no main app chrome」；与未来 SPA 收编主 chrome 存在形态决策点（见
// docs/audit/2026-06-13-visual-gap.md §5 决策点③），收编 chrome 前须 owner
// 显式拍板。本次平移仅做路由收编，不改壳形态——admin 页保持 pre-loom legacy
// 视觉与无主 app chrome 形态。

import { apiJson } from '@/ui/lib/api';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';

export interface AdminSurfaceProps {
  navigate: (to: string) => void;
}

interface AdminRunRow {
  id: string;
  task_kind: string;
  provider: string;
  model: string;
  input_hash: string;
  status: 'running' | 'success' | 'failure' | string;
  finish_reason: string | null;
  usage_json: { inputTokens: number; outputTokens: number };
  cost_usd: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  ledger_cost_usd: number;
  ledger_rows: number;
  tool_call_count: number;
  pgboss_job_ids: string[];
}

interface AdminRunsResponse {
  rows: AdminRunRow[];
  limit: number;
  total: number;
  truncated: boolean;
}

interface TimelineEvent {
  type: 'run_started' | 'tool_call' | 'cost_ledger' | 'run_finished';
  at: string;
  label: string;
  id?: string;
  tool_name?: string;
  iteration?: number;
  latency_ms?: number;
  cost?: number;
  tokens_in?: number;
  tokens_out?: number;
  outcome?: string;
  pgboss_job_id?: string | null;
}

interface RunDetail {
  run: AdminRunRow;
  timeline: TimelineEvent[];
  ledger: Array<{ id: string; pgboss_job_id: string | null; cost: number; outcome: string }>;
  tool_calls: Array<{ id: string; tool_name: string; latency_ms: number; iteration: number }>;
}

interface CostResponse {
  days_window: number;
  days: Array<{ day: string; cost: number; tokens_in: number; tokens_out: number; calls: number }>;
  by_task: Array<{
    task_kind: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    calls: number;
  }>;
}

interface FailureCluster {
  key: string;
  finish_reason: string;
  error_prefix: string;
  count: number;
  latest_at: string;
  samples: Array<{
    id: string;
    task_kind: string;
    model: string;
    started_at: string;
    error_message: string | null;
  }>;
}

function formatMoney(value: number | null | undefined): string {
  return `$${(value ?? 0).toFixed(4)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function formatTime(value: string | null): string {
  if (!value) return 'running';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'running';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function statusTone(status: string): BadgeTone {
  if (status === 'success') return 'good';
  if (status === 'failure') return 'again';
  if (status === 'running') return 'info';
  return 'neutral';
}

function timelineTone(type: TimelineEvent['type']): BadgeTone {
  if (type === 'tool_call') return 'info';
  if (type === 'cost_ledger') return 'coral';
  if (type === 'run_finished') return 'good';
  return 'neutral';
}

function shortId(id: string): string {
  return id.slice(0, 10);
}

function LoadingCard({ label }: { label: string }) {
  return (
    <Card pad="lg">
      <p style={mutedTextStyle}>{label} 加载中...</p>
    </Card>
  );
}

function ErrorCard({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Card pad="lg">
      <Badge tone="again">error</Badge>
      <p style={mutedTextStyle}>{message}</p>
    </Card>
  );
}

function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-num">{value}</div>
      {note && <div className="kpi-trend">{note}</div>}
    </div>
  );
}

function AdminLink({
  to,
  navigate,
  children,
}: {
  to: string;
  navigate: (to: string) => void;
  children: string;
}) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function AdminLinks({ navigate }: AdminSurfaceProps) {
  return (
    <div style={linkRowStyle}>
      <AdminLink to="/admin/runs" navigate={navigate}>
        runs
      </AdminLink>
      <AdminLink to="/admin/cost" navigate={navigate}>
        cost
      </AdminLink>
      <AdminLink to="/admin/failures" navigate={navigate}>
        failures
      </AdminLink>
    </div>
  );
}

export function AdminRunsSurface({ navigate }: AdminSurfaceProps) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [staleRunId, setStaleRunId] = useState<string | null>(null);
  const runsQ = useQuery({
    queryKey: ['admin-runs'],
    queryFn: () => apiJson<AdminRunsResponse>('/api/admin/runs?limit=100'),
    refetchInterval: 60_000,
  });
  const runs = runsQ.data?.rows ?? [];
  const shownLimit = runsQ.data?.limit ?? 100;
  const totalRuns = runsQ.data?.total ?? runs.length;
  const isTruncated = Boolean(runsQ.data?.truncated);
  useEffect(() => {
    if (!runsQ.isSuccess) return;
    if (staleRunId && runs.some((run) => run.id === staleRunId)) {
      setStaleRunId(null);
    }
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) {
      setStaleRunId(selectedRunId);
      setSelectedRunId(runs[0]?.id ?? null);
      return;
    }
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0].id);
  }, [runs, runsQ.isSuccess, selectedRunId, staleRunId]);

  const detailQ = useQuery({
    queryKey: ['admin-run-detail', selectedRunId],
    queryFn: () => apiJson<RunDetail>(`/api/admin/runs/${selectedRunId}`),
    enabled: Boolean(selectedRunId),
  });

  const totals = useMemo(() => {
    const failed = runs.filter((run) => run.status === 'failure').length;
    const running = runs.filter((run) => run.status === 'running').length;
    const spend = runs.reduce((sum, run) => sum + run.cost_usd, 0);
    const toolCalls = runs.reduce((sum, run) => sum + run.tool_call_count, 0);
    return { failed, running, spend, toolCalls };
  }, [runs]);

  const selectRun = (runId: string) => {
    setStaleRunId(null);
    setSelectedRunId(runId);
  };

  const refreshRuns = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-runs'] });
    if (selectedRunId) {
      void queryClient.invalidateQueries({ queryKey: ['admin-run-detail', selectedRunId] });
    }
  };

  return (
    <main className="page wide">
      <PageHeader
        title="AI Runs"
        eyebrow="ADMIN · runtime evidence"
        sub="AI task run 列表、单 run 时间线、pg-boss job id 与 tool_call_log 串联视图。"
      >
        <AdminLinks navigate={navigate} />
        <Button variant="secondary" icon="refresh" onClick={refreshRuns}>
          刷新
        </Button>
      </PageHeader>

      <div className="kpi-strip">
        <Kpi label="runs" value={runs.length} note={`${runs.length} / ${totalRuns} shown`} />
        <Kpi label="failed" value={totals.failed} note={totals.failed ? 'needs triage' : 'clear'} />
        <Kpi label="running" value={totals.running} note="currently open" />
        <Kpi label="spend" value={formatMoney(totals.spend)} note={`${totals.toolCalls} tools`} />
      </div>

      {runsQ.isLoading && <LoadingCard label="runs" />}
      {runsQ.error && <ErrorCard error={runsQ.error} />}

      {!runsQ.isLoading && !runsQ.error && (
        <div className="admin-two-column">
          <Card pad="lg">
            <div style={sectionHeadStyle}>
              <h2 style={sectionTitleStyle}>Recent runs</h2>
              <div style={badgeRowStyle}>
                <Badge tone="neutral">
                  {runs.length} / {totalRuns}
                </Badge>
                {isTruncated && <Badge tone="info">limit {shownLimit}</Badge>}
              </div>
            </div>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>task</th>
                    <th style={thStyle}>status</th>
                    <th style={thStyle}>cost</th>
                    <th style={thStyle}>tools</th>
                    <th style={thStyle}>started</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          onClick={() => selectRun(run.id)}
                          style={{
                            ...rowButtonStyle,
                            color: selectedRunId === run.id ? 'var(--coral)' : 'var(--ink)',
                          }}
                        >
                          <span>{run.task_kind}</span>
                          <code>{shortId(run.id)}</code>
                        </button>
                      </td>
                      <td style={tdStyle}>
                        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      </td>
                      <td style={tdStyle}>{formatMoney(run.cost_usd)}</td>
                      <td style={tdStyle}>{run.tool_call_count}</td>
                      <td style={tdStyle}>{formatTime(run.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card pad="lg">
            <div style={sectionHeadStyle}>
              <h2 style={sectionTitleStyle}>Timeline</h2>
              {detailQ.data?.run && (
                <Badge tone={statusTone(detailQ.data.run.status)}>{detailQ.data.run.status}</Badge>
              )}
            </div>
            {detailQ.isLoading && <p style={mutedTextStyle}>timeline 加载中...</p>}
            {detailQ.error && <ErrorCard error={detailQ.error} />}
            {staleRunId && (
              <p style={warningTextStyle}>
                run {shortId(staleRunId)} left the current list after refresh; showing the latest
                listed run.
              </p>
            )}
            {detailQ.data && (
              <div style={timelineStyle}>
                <div style={metaGridStyle}>
                  <span>run {shortId(detailQ.data.run.id)}</span>
                  <span>job {detailQ.data.run.pgboss_job_ids.join(', ') || 'none'}</span>
                  <span>{formatDuration(detailQ.data.run.duration_ms)}</span>
                  <span>{formatMoney(detailQ.data.run.cost_usd)}</span>
                </div>
                {detailQ.data.timeline.map((event, index) => (
                  <div key={`${event.type}-${event.id ?? index}`} style={timelineRowStyle}>
                    <Badge tone={timelineTone(event.type)}>{event.type}</Badge>
                    <div style={{ minWidth: 0 }}>
                      <div style={timelineLabelStyle}>
                        {event.label}
                        {event.pgboss_job_id && <code> · {event.pgboss_job_id}</code>}
                      </div>
                      <div style={timelineMetaStyle}>
                        {formatTime(event.at)}
                        {typeof event.latency_ms === 'number' && ` · ${event.latency_ms}ms`}
                        {typeof event.cost === 'number' && ` · ${formatMoney(event.cost)}`}
                        {typeof event.tokens_in === 'number' &&
                          ` · tokens ${event.tokens_in}/${event.tokens_out}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </main>
  );
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
  const totalCost = days.reduce((sum, row) => sum + row.cost, 0);
  const totalCalls = days.reduce((sum, row) => sum + row.calls, 0);
  const totalTokens = days.reduce((sum, row) => sum + row.tokens_in + row.tokens_out, 0);
  const maxDayCost = Math.max(...days.map((row) => row.cost), 0.000001);
  const maxTaskCost = Math.max(...byTask.map((row) => row.cost), 0.000001);

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
        <Kpi label="30d spend" value={formatMoney(totalCost)} note={`${days.length} days`} />
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
                <div key={row.day} className="admin-bar-row">
                  <span style={barLabelStyle}>{row.day}</span>
                  <span style={barTrackStyle} className="admin-bar-track">
                    <span style={{ ...barFillStyle, width: `${(row.cost / maxDayCost) * 100}%` }} />
                  </span>
                  <span style={barValueStyle}>{formatMoney(row.cost)}</span>
                </div>
              ))}
              {days.length === 0 && <p style={mutedTextStyle}>No cost rows in the window.</p>}
            </div>
          </Card>

          <Card pad="lg">
            <h2 style={sectionTitleStyle}>By task kind</h2>
            <div style={barListStyle}>
              {byTask.map((row) => (
                <div key={row.task_kind} className="admin-bar-row">
                  <span style={barLabelStyle}>{row.task_kind}</span>
                  <span style={barTrackStyle} className="admin-bar-track">
                    <span
                      style={{ ...barFillStyle, width: `${(row.cost / maxTaskCost) * 100}%` }}
                    />
                  </span>
                  <span style={barValueStyle}>
                    {formatMoney(row.cost)} · {row.calls}
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

export function AdminFailuresSurface({ navigate }: AdminSurfaceProps) {
  const queryClient = useQueryClient();
  const failuresQ = useQuery({
    queryKey: ['admin-failures'],
    queryFn: () => apiJson<{ clusters: FailureCluster[] }>('/api/admin/failures?limit=200'),
    refetchInterval: 60_000,
  });
  const clusters = failuresQ.data?.clusters ?? [];
  const totalFailures = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  const top = clusters[0];

  return (
    <main className="page wide">
      <PageHeader
        title="Failures"
        eyebrow="ADMIN · failure clusters"
        sub="按 `finish_reason` 与 error message 前缀聚类失败样本，先看重复失败而不是逐条翻日志。"
      >
        <AdminLinks navigate={navigate} />
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin-failures'] });
          }}
        >
          刷新
        </Button>
      </PageHeader>

      <div className="kpi-strip">
        <Kpi label="failed runs" value={totalFailures} note="latest 200" />
        <Kpi label="clusters" value={clusters.length} note="reason + prefix" />
        <Kpi label="top count" value={top?.count ?? 0} note={top?.finish_reason ?? 'none'} />
        <Kpi
          label="samples"
          value={clusters.reduce((sum, c) => sum + c.samples.length, 0)}
          note="shown"
        />
      </div>

      {failuresQ.isLoading && <LoadingCard label="failures" />}
      {failuresQ.error && <ErrorCard error={failuresQ.error} />}

      {failuresQ.data && (
        <div style={clusterListStyle}>
          {clusters.map((cluster) => (
            <Card key={cluster.key} pad="lg">
              <div style={sectionHeadStyle}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>{cluster.error_prefix}</h2>
                  <p style={mutedTextStyle}>
                    latest {formatTime(cluster.latest_at)} · {cluster.samples.length} samples shown
                  </p>
                </div>
                <Badge tone="again">
                  {cluster.finish_reason} · {cluster.count}
                </Badge>
              </div>
              <div className="admin-sample-grid">
                {cluster.samples.map((sample) => (
                  <div key={sample.id} style={sampleStyle}>
                    <code>{shortId(sample.id)}</code>
                    <span>{sample.task_kind}</span>
                    <span>{sample.model}</span>
                    <span>{formatTime(sample.started_at)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {clusters.length === 0 && (
            <Card pad="lg">
              <Badge tone="good">clear</Badge>
              <p style={mutedTextStyle}>No failed AI task runs in the latest window.</p>
            </Card>
          )}
        </div>
      )}
    </main>
  );
}

const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};

const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: 'var(--ls-tight)',
};

const badgeRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  flexWrap: 'wrap',
};

const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0 10px 8px 0',
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  borderTop: '1px solid var(--line-soft)',
  padding: '10px 10px 10px 0',
  verticalAlign: 'top',
  color: 'var(--ink-2)',
};

const rowButtonStyle: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  gap: 2,
  alignItems: 'flex-start',
  padding: 0,
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  textAlign: 'left',
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};

const warningTextStyle: CSSProperties = {
  margin: '0 0 var(--s-3)',
  color: 'var(--ink)',
  fontSize: 14,
  lineHeight: 1.5,
};

const timelineStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const metaGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  marginBottom: 6,
};

const timelineRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '116px minmax(0, 1fr)',
  gap: 12,
  alignItems: 'start',
  padding: '10px 0',
  borderTop: '1px solid var(--line-soft)',
};

const timelineLabelStyle: CSSProperties = {
  color: 'var(--ink)',
  fontWeight: 500,
  overflowWrap: 'anywhere',
};

const timelineMetaStyle: CSSProperties = {
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  marginTop: 3,
};

const barListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

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

const clusterListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 'var(--s-4)',
};

const sampleStyle: CSSProperties = {
  display: 'contents',
  color: 'var(--ink-3)',
};
