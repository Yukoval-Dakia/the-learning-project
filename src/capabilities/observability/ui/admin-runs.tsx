import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, type ChipTone } from '@/ui-next/public';
import type { AdminRunDto, AdminRunTimelineEventDto } from '../public';
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
import {
  type AdminSurfaceProps,
  formatMoney,
  formatTime,
  shortId,
  statusTone,
} from './observability-shared';

export type AdminRunRow = AdminRunDto;
export type TimelineEvent = AdminRunTimelineEventDto;

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  success: '已完成',
  failure: '失败',
};

const TIMELINE_TYPE_LABEL: Record<string, string> = {
  run_started: '开始运行',
  tool_call: '工具调用',
  cost_ledger: '费用记录',
  run_finished: '运行结束',
};

function statusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? '处理中';
}

function taskLabel(taskKind: string): string {
  return taskKind
    .split(/[_:.-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '运行中';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function timelineTone(event: Pick<TimelineEvent, 'type' | 'label' | 'outcome'>): ChipTone {
  if (event.type === 'tool_call') return 'accent';
  if (event.type === 'cost_ledger') {
    return event.outcome === 'error' || event.outcome === 'failure' ? 'critical' : 'caution';
  }
  if (event.type === 'run_finished') {
    if (event.label === 'success') return 'positive';
    if (event.label === 'failure') return 'critical';
    if (
      event.outcome === 'failure' ||
      event.outcome === 'error' ||
      event.outcome === 'tool_error'
    ) {
      return 'critical';
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

const COPY_LABEL: Record<'idle' | 'copied' | 'failed', string> = {
  idle: '复制错误摘要',
  copied: '已复制',
  failed: '复制失败，请手动选择',
};

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
    <div className="adm-outcome">
      <div className="adm-chip-row">
        <Chip tone={statusTone(run.status)}>结果：{statusLabel(run.status)}</Chip>
        <Chip>结束原因：{finishReason}</Chip>
      </div>
      {errorSummary && (
        <div className="adm-err-summary">
          <code aria-label="错误摘要" className="adm-err-code">
            {errorSummary}
          </code>
          <Button variant="quiet" size="sm" onClick={() => void copyError()}>
            {COPY_LABEL[copyState]}
          </Button>
        </div>
      )}
    </div>
  );
}

export function AdminRunsSurface({
  navigate,
  client = httpAdminClient,
}: AdminSurfaceProps & { client?: AdminReadClient }) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [staleRunId, setStaleRunId] = useState<string | null>(null);
  const runsQ = useQuery({
    queryKey: ['admin-runs'],
    queryFn: () => client.getRuns({ limit: '100' }),
    refetchInterval: 60_000,
  });
  const runs = runsQ.data?.rows ?? [];
  const shownLimit = runsQ.data?.limit ?? 100;
  const totalRuns = runsQ.data?.total ?? runs.length;
  const isTruncated = Boolean(runsQ.data?.truncated);
  // Reconcile the selection once per successful list read. Keyed on the response object so a
  // failed refetch (isSuccess=false, old data kept) never clears the pick or reports a run as
  // gone; only a fresh successful list can move the selection or mark the old pick stale.
  const [reconciledRuns, setReconciledRuns] = useState<typeof runsQ.data>(undefined);
  if (runsQ.isSuccess && runsQ.data !== reconciledRuns) {
    setReconciledRuns(runsQ.data);
    let nextStale = staleRunId;
    if (nextStale && runs.some((run) => run.id === nextStale)) nextStale = null;
    let nextSelected = selectedRunId;
    if (nextSelected && !runs.some((run) => run.id === nextSelected)) {
      nextStale = nextSelected;
      nextSelected = runs[0]?.id ?? null;
    } else if (!nextSelected && runs.length > 0) {
      nextSelected = runs[0].id;
    }
    if (nextStale !== staleRunId) setStaleRunId(nextStale);
    if (nextSelected !== selectedRunId) setSelectedRunId(nextSelected);
  }

  const detailQ = useQuery({
    queryKey: ['admin-run-detail', selectedRunId],
    queryFn: () => client.getRunDetail({ id: selectedRunId ?? '' }),
    enabled: Boolean(selectedRunId),
  });

  const totals = useMemo(() => {
    const failed = runs.filter((run) => run.status === 'failure').length;
    const running = runs.filter((run) => run.status === 'running').length;
    const spend = runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
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
    <AdminFrame>
      <AdminNav links={ADMIN_LINKS} current="/admin/runs" navigate={navigate} />
      <AdminHead
        kicker="管理 · 运行证据"
        title="AI 任务运行记录"
        lead="查看 AI 任务的状态、费用、工具调用和结束原因。"
        actions={
          <Button onClick={refreshRuns}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </Button>
        }
      />

      <AdminKpis>
        <AdminKpi label="运行记录" value={runs.length} note={`${runs.length} / ${totalRuns} 条`} />
        <AdminKpi
          label="失败"
          value={totals.failed}
          note={failedWindowNote(totals.failed, runs.length, totalRuns)}
        />
        <AdminKpi label="运行中" value={totals.running} note="尚未结束" />
        <AdminKpi
          label="费用"
          value={formatMoney(totals.spend)}
          note={`${totals.toolCalls} 次工具调用`}
        />
      </AdminKpis>

      {runsQ.isLoading && <AdminLoading label="runs 加载中" />}
      {runsQ.error && <AdminError error={runsQ.error} />}

      {!runsQ.isLoading && !runsQ.error && (
        <div className="adm-split">
          <AdminPanel
            id="adm-runs-list"
            title="最近运行"
            flush
            aside={
              <>
                <Chip>
                  {runs.length} / {totalRuns}
                </Chip>
                {isTruncated && <Chip tone="accent">limit {shownLimit}</Chip>}
              </>
            }
          >
            <div className="adm-table-scroll">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">任务</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="adm-num">
                      费用
                    </th>
                    <th scope="col" className="adm-num">
                      工具调用
                    </th>
                    <th scope="col">开始时间</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} data-selected={selectedRunId === run.id ? '' : undefined}>
                      <td>
                        <button
                          type="button"
                          className="adm-run-pick un-hit"
                          aria-current={selectedRunId === run.id ? 'true' : undefined}
                          onClick={() => selectRun(run.id)}
                        >
                          <span className="adm-run-task">{taskLabel(run.task_kind)}</span>
                          <code className="adm-mono adm-quiet">{shortId(run.id)}</code>
                        </button>
                      </td>
                      <td>
                        <Chip tone={statusTone(run.status)}>{statusLabel(run.status)}</Chip>
                      </td>
                      <td className="adm-num adm-mono">{formatMoney(run.cost_usd)}</td>
                      <td className="adm-num adm-mono">{run.tool_call_count}</td>
                      <td className="adm-mono adm-quiet">{formatTime(run.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminPanel>

          <AdminPanel
            id="adm-run-timeline"
            title="Timeline"
            aside={
              detailQ.data?.run && (
                <Chip tone={statusTone(detailQ.data.run.status)}>
                  {statusLabel(detailQ.data.run.status)}
                </Chip>
              )
            }
          >
            {detailQ.isLoading && <SkeletonLines rows={4} label="运行时间线加载中" />}
            {detailQ.error && <AdminError error={detailQ.error} />}
            {staleRunId && (
              <p className="adm-warn">
                运行记录 {shortId(staleRunId)} 刷新后已离开当前列表，已展示最新记录。
              </p>
            )}
            {detailQ.data && (
              <div className="adm-timeline">
                <div className="adm-run-meta">
                  <span>run {shortId(detailQ.data.run.id)}</span>
                  <span>job {detailQ.data.run.pgboss_job_ids.join(', ') || 'none'}</span>
                  <span>{formatDuration(detailQ.data.run.duration_ms)}</span>
                  <span>{formatMoney(detailQ.data.run.cost_usd)}</span>
                </div>
                <RunOutcomeSummary key={detailQ.data.run.id} run={detailQ.data.run} />
                <ol className="adm-events">
                  {detailQ.data.timeline.map((event, index) => (
                    <li key={`${event.type}-${event.id ?? index}`} className="adm-event">
                      <span className="adm-event-type">
                        <Chip tone={timelineTone(event)}>
                          {TIMELINE_TYPE_LABEL[event.type] ?? '运行事件'}
                        </Chip>
                      </span>
                      <div className="adm-event-body">
                        <div className="adm-event-label">
                          {event.label}
                          {event.pgboss_job_id && (
                            <code className="adm-mono adm-quiet"> · {event.pgboss_job_id}</code>
                          )}
                        </div>
                        <div className="adm-event-meta">
                          {formatTime(event.at)}
                          {typeof event.latency_ms === 'number' && ` · ${event.latency_ms}ms`}
                          {typeof event.cost === 'number' && ` · ${formatMoney(event.cost)}`}
                          {typeof event.tokens_in === 'number' &&
                            ` · tokens ${event.tokens_in}/${event.tokens_out}`}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </AdminPanel>
        </div>
      )}
    </AdminFrame>
  );
}
