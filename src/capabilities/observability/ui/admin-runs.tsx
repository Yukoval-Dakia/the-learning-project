import { apiJson } from '@/ui/lib/api';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  AdminLinks,
  type AdminSurfaceProps,
  ErrorCard,
  Kpi,
  LoadingCard,
  formatMoney,
  formatTime,
  mutedTextStyle,
  sectionHeadStyle,
  sectionTitleStyle,
  shortId,
  statusTone,
} from './observability-shared';

export interface AdminRunRow {
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

export interface TimelineEvent {
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

function formatDuration(ms: number | null): string {
  if (ms === null) return 'running';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function timelineTone(event: Pick<TimelineEvent, 'type' | 'label' | 'outcome'>): BadgeTone {
  if (event.type === 'tool_call') return 'info';
  if (event.type === 'cost_ledger') {
    return event.outcome === 'error' || event.outcome === 'failure' ? 'again' : 'coral';
  }
  if (event.type === 'run_finished') {
    if (event.label === 'success') return 'good';
    if (event.label === 'failure') return 'again';
    if (
      event.outcome === 'failure' ||
      event.outcome === 'error' ||
      event.outcome === 'tool_error'
    ) {
      return 'again';
    }
  }
  return 'neutral';
}

export function shortErrorSummary(message: string | null, limit = 180): string | null {
  if (!message) return null;
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function failedWindowNote(failed: number, shown: number, totalRuns: number): string {
  return `${failed} / ${shown} in current window · ${totalRuns} total runs`;
}

function RunOutcomeSummary({ run }: { run: AdminRunRow }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const errorSummary = shortErrorSummary(run.error_message);
  const finishReason = run.finish_reason ?? (run.status === 'running' ? 'pending' : 'unknown');

  const copyError = async () => {
    if (!errorSummary) return;
    try {
      await navigator.clipboard.writeText(errorSummary);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div style={outcomeSummaryStyle}>
      <div style={badgeRowStyle}>
        <Badge tone={statusTone(run.status)}>outcome: {run.status}</Badge>
        <Badge tone="neutral">finish: {finishReason}</Badge>
      </div>
      {errorSummary && (
        <div style={errorSummaryRowStyle}>
          <code aria-label="错误摘要" style={errorSummaryStyle}>
            {errorSummary}
          </code>
          <Button variant="quiet" size="sm" onClick={() => void copyError()}>
            {copyState === 'copied'
              ? '已复制'
              : copyState === 'failed'
                ? '复制失败，请手动选择'
                : '复制错误摘要'}
          </Button>
        </div>
      )}
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
    if (staleRunId && runs.some((run) => run.id === staleRunId)) setStaleRunId(null);
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
        <Kpi
          label="failed"
          value={totals.failed}
          note={failedWindowNote(totals.failed, runs.length, totalRuns)}
        />
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
                <RunOutcomeSummary key={detailQ.data.run.id} run={detailQ.data.run} />
                {detailQ.data.timeline.map((event, index) => (
                  <div key={`${event.type}-${event.id ?? index}`} style={timelineRowStyle}>
                    <Badge tone={timelineTone(event)}>{event.type}</Badge>
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

const badgeRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  flexWrap: 'wrap',
};
const tableWrapStyle: CSSProperties = { overflowX: 'auto' };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
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
const warningTextStyle: CSSProperties = {
  margin: '0 0 var(--s-3)',
  color: 'var(--ink)',
  fontSize: 14,
  lineHeight: 1.5,
};
const timelineStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const metaGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  marginBottom: 6,
};
const outcomeSummaryStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginBottom: 6,
  padding: '10px 0',
  borderTop: '1px solid var(--line-soft)',
};
const errorSummaryRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
};
const errorSummaryStyle: CSSProperties = {
  minWidth: 0,
  flex: '1 1 260px',
  color: 'var(--again-ink)',
  background: 'var(--again-soft)',
  border: '1px solid var(--again-line)',
  borderRadius: 'var(--r-2)',
  padding: '8px 10px',
  overflowWrap: 'anywhere',
  whiteSpace: 'normal',
  userSelect: 'text',
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
