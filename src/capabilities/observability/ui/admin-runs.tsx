import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { apiJson } from '@/ui/lib/api';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, type ChipTone } from '@/ui-next/public';
import type { AdminRunDto, AdminRunTimelineEventDto, TaskFailureAlertsRead } from '../public';
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
  type AdminRunCostTruth,
  type AdminSurfaceProps,
  costBasisLabel,
  describeCostWindow,
  describeRunCost,
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

/**
 * One run's cost cell: the known amount with its basis, or an explicit
 * unknown. A real zero stays a zero; a missing amount never reads as one.
 */
function runCostCell(run: AdminRunRow): string {
  const truth = describeRunCost(run);
  if (truth.amount === null) {
    return truth.unknownEntries > 0 ? '费用未知' : '无费用记录';
  }
  return formatMoney(truth.amount, truth.currency ?? 'USD');
}

/** The detail block's cost line: amount plus the basis it came from. */
function runCostLine(truth: AdminRunCostTruth): string {
  if (truth.amount === null) {
    return truth.unknownEntries > 0 ? `费用未知 · ${truth.unknownEntries} 次未知` : '无费用记录';
  }
  const basis = costBasisLabel(truth.basis);
  const unknown = truth.unknownEntries > 0 ? ` · ${truth.unknownEntries} 次未知` : '';
  return `${formatMoney(truth.amount, truth.currency ?? 'USD')} · ${basis}${unknown}`;
}

/**
 * One timeline event's cost text. A ledger row without an amount is an
 * unknown amount, not a zero; a tool call's cost column is a local tool
 * cost with no price of its own.
 */
function timelineCostText(event: TimelineEvent): string | null {
  if (event.type === 'tool_call') return null;
  if (event.type === 'cost_ledger') {
    const currency = event.currency ?? 'USD';
    if (typeof event.cost === 'number') {
      const basis =
        event.entry_kind === 'legacy'
          ? '历史口径'
          : event.cost_basis === 'reported'
            ? '已报告'
            : event.cost_basis === 'estimated'
              ? '估算'
              : '未知';
      return `${formatMoney(event.cost, currency)} · ${basis}`;
    }
    return '费用未知';
  }
  if (event.type === 'run_finished') {
    const currency = event.currency ?? 'USD';
    if (typeof event.cost === 'number') {
      const basis =
        event.cost_basis === 'reported'
          ? '已报告'
          : event.cost_basis === 'estimated'
            ? '估算'
            : event.cost_basis === 'unknown'
              ? '未知'
              : '历史口径';
      return `${formatMoney(event.cost, currency)} · ${basis}`;
    }
    return event.cost_basis === 'unknown' ? '费用未知' : null;
  }
  return null;
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

type TaskFailureAlertRow = TaskFailureAlertsRead['alerts'][number];

const readTaskFailureAlertsHttp = () =>
  apiJson<TaskFailureAlertsRead>('/api/observability/task-failure-alerts');

function alertRuleText(alert: TaskFailureAlertRow, windowHours: number): string {
  if (alert.rule === 'consecutive') return `连续失败 ${alert.failures} 次`;
  return `${windowHours} 小时内失败 ${alert.failures} / ${alert.runs} 次`;
}

function alertLastSuccessText(alert: TaskFailureAlertRow): string {
  if (alert.last_success_at) return formatTime(alert.last_success_at);
  if (alert.rule === 'consecutive') return '从未成功';
  return '窗口内没有成功';
}

function AlertTaskCell({ taskKind }: { taskKind: string }) {
  return (
    <td>
      <span className="adm-run-task">{taskLabel(taskKind)}</span>
      {taskLabel(taskKind) !== taskKind && <code className="adm-mono adm-quiet"> {taskKind}</code>}
    </td>
  );
}

function AlertRecordedCell({ recordedAt }: { recordedAt: string | null | undefined }) {
  return (
    <td>
      {recordedAt ? (
        <Chip tone="positive">已记录 · {formatTime(recordedAt)}</Chip>
      ) : (
        <Chip>下次整点检查时记录</Chip>
      )}
    </td>
  );
}

// Dependency and process reports can need attention while every task succeeds.
// Keep their evidence separate from task failure rates and delivered replies.
function TaskFailureAlertsPanel({
  read,
  onOpenRun,
  onOpenConfig,
}: {
  read: () => Promise<TaskFailureAlertsRead>;
  onOpenRun: (runId: string) => void;
  onOpenConfig: () => void;
}) {
  const alertsQ = useQuery({
    queryKey: ['admin-task-failure-alerts'],
    queryFn: read,
    refetchInterval: 60_000,
  });
  if (alertsQ.error)
    return (
      <div className="adm-chip-row" role="alert">
        <p className="adm-warn">运行状态暂时读不到，可单独重试。</p>
        <Button variant="quiet" onClick={() => void alertsQ.refetch()}>
          重试状态检查
        </Button>
      </div>
    );
  const data = alertsQ.data;
  if (!data) return <SkeletonLines rows={2} label="运行状态检查中" />;
  const failing = data.alerts.filter((alert) => alert.rule !== 'unsealed');
  const unsealed = data.alerts.filter((alert) => alert.rule === 'unsealed');
  return (
    <>
      {failing.length > 0 && (
        <AdminPanel
          id="adm-failure-alerts"
          title="持续失败的任务"
          sub={`连续失败 ${data.thresholds.consecutive_failures} 次，或 ${data.thresholds.window_hours} 小时内失败率超过 ${Math.round(data.thresholds.failure_rate_above * 100)}% 时列出 · ${formatTime(data.checked_at)} 检查`}
          aside={<Chip tone="critical">{failing.length} 项</Chip>}
          flush
        >
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">任务</th>
                  <th scope="col">失败</th>
                  <th scope="col">最近失败</th>
                  <th scope="col">上次成功</th>
                  <th scope="col">告警记录</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {failing.map((alert) => (
                  <tr key={alert.id}>
                    <AlertTaskCell taskKind={alert.task_kind} />
                    <td>
                      <Chip tone="critical">
                        {alertRuleText(alert, data.thresholds.window_hours)}
                      </Chip>
                      {alert.latest_finish_reason && (
                        <code className="adm-mono adm-quiet"> {alert.latest_finish_reason}</code>
                      )}
                    </td>
                    <td className="adm-mono adm-quiet">{formatTime(alert.last_failure_at)}</td>
                    <td className="adm-mono adm-quiet">{alertLastSuccessText(alert)}</td>
                    <AlertRecordedCell recordedAt={alert.recorded_at} />
                    <td>
                      <Button onClick={() => onOpenRun(alert.latest_run_id)}>
                        查看最近一次运行
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      )}
      {unsealed.length > 0 && (
        <AdminPanel
          id="adm-unsealed-alerts"
          title="回复已送达，收尾记录没写完"
          sub={`回复已写入对话，不计入失败率，但内容可能不完整。可能是超过 64k 被截断，或回执没封存，具体原因看最近一次运行 · ${formatTime(data.checked_at)} 检查`}
          aside={<Chip tone="caution">{unsealed.length} 项</Chip>}
          flush
        >
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">任务</th>
                  <th scope="col">最近一次</th>
                  <th scope="col">告警记录</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {unsealed.map((alert) => (
                  <tr key={alert.id}>
                    <AlertTaskCell taskKind={alert.task_kind} />
                    <td className="adm-mono adm-quiet">{formatTime(alert.last_failure_at)}</td>
                    <AlertRecordedCell recordedAt={alert.recorded_at} />
                    <td>
                      <Button onClick={() => onOpenRun(alert.latest_run_id)}>
                        查看最近一次运行
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      )}
      {data.dependency_notices.length > 0 && (
        <AdminPanel
          id="adm-dependency-notices"
          title="外部资料暂时受限"
          sub={`依赖检查记录 · ${formatTime(data.checked_at)} 检查`}
          aside={<Chip tone="caution">{data.dependency_notices.length} 项</Chip>}
          flush
        >
          <div className="adm-table-scroll">
            <table className="adm-table adm-table-wide">
              <thead>
                <tr>
                  <th scope="col">影响</th>
                  <th scope="col" className="adm-num">
                    连续不可用
                  </th>
                  <th scope="col">最近记录</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.dependency_notices.map((notice) => (
                  <tr key={notice.dependency}>
                    <td>
                      <span className="adm-run-task">{notice.learner_title}</span>
                      <p className="adm-quiet">{notice.learner_detail}</p>
                      <span className="adm-quiet">开始于 {formatTime(notice.since)}</span>
                    </td>
                    <td className="adm-num">{notice.failures} 次</td>
                    <td className="adm-mono adm-quiet">{formatTime(notice.last_failure_at)}</td>
                    <td>
                      <Button onClick={() => onOpenRun(notice.latest_run_id)}>查看相关运行</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      )}
      {data.config_incomplete.length > 0 && (
        <AdminPanel
          id="adm-config-incomplete"
          title="进程报告了配置缺项"
          sub={`API 为本次检查；后台任务进程为最近一天内的启动报告，可能早于配置修复 · ${formatTime(data.checked_at)} 检查`}
          aside={
            <Button variant="quiet" onClick={onOpenConfig}>
              查看配置
            </Button>
          }
          flush
        >
          <div className="adm-table-scroll">
            <table className="adm-table adm-table-wide">
              <thead>
                <tr>
                  <th scope="col">进程</th>
                  <th scope="col">缺少的设置</th>
                  <th scope="col">记录时间</th>
                </tr>
              </thead>
              <tbody>
                {data.config_incomplete.map((report) => (
                  <tr key={report.process}>
                    <td>{report.process === 'api' ? 'API 服务' : '后台任务进程'}</td>
                    <td>
                      <div className="adm-chip-row">
                        {report.missing.map((name) => (
                          <code key={name}>{name}</code>
                        ))}
                      </div>
                    </td>
                    <td className="adm-mono adm-quiet">{formatTime(report.seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      )}
    </>
  );
}

export function AdminRunsSurface({
  navigate,
  client = httpAdminClient,
  readTaskFailureAlerts = readTaskFailureAlertsHttp,
}: AdminSurfaceProps & {
  client?: AdminReadClient;
  /** YUK-1738 — the alert read; the Start route passes its server function. */
  readTaskFailureAlerts?: () => Promise<TaskFailureAlertsRead>;
}) {
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
    // Known subtotal per currency plus explicit unknown counts; a missing
    // amount never becomes a zero spend and currencies are never added.
    const spend = describeCostWindow(runs);
    const toolCalls = runs.reduce((sum, run) => sum + run.tool_call_count, 0);
    return { failed, running, spend, toolCalls };
  }, [runs]);

  const selectRun = (runId: string) => {
    setStaleRunId(null);
    setSelectedRunId(runId);
  };
  // An alert's latest run may be older than the 100 listed; the detail still loads by id, and
  // the next list read reconciles the pick exactly like any other selection.
  const openAlertRun = (runId: string) => {
    selectRun(runId);
    document.getElementById('adm-run-timeline')?.scrollIntoView({ block: 'start' });
  };
  const refreshRuns = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-runs'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-task-failure-alerts'] });
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

      <TaskFailureAlertsPanel
        read={readTaskFailureAlerts}
        onOpenRun={openAlertRun}
        onOpenConfig={() => navigate('/admin/config')}
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
          value={totals.spend.amount}
          note={`${totals.toolCalls} 次工具调用 · ${totals.spend.note}`}
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
                      <td className="adm-num adm-mono">{runCostCell(run)}</td>
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
                  <span>{runCostLine(describeRunCost(detailQ.data.run))}</span>
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
                          {timelineCostText(event) && ` · ${timelineCostText(event)}`}
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
