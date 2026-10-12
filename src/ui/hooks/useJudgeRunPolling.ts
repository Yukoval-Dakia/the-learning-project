// YUK-1051 — 202-pending 的「同一次 submission 继续查询」poll hook。
//
// 契约（submit.ts durablePendingResponse）：202 body 带 { run_id, verdict:'pending',
// backfill: { channel:'sse', url, poll_url } }。本 hook 只轮询 poll_url（GET 纯读），
// 直到终态（done/failed）——**永不重交同一答案**；SSE 主通道由宿主另行接入时，
// 两者读同一个 run_id，互不冲突。
//
// 轮询策略：固定起步间隔 + 温和退避（×1.5，封顶），终态/卸载/换 run 即停；
// 连续错误超阈值（默认 5 次）停机并把 error 交给宿主（不无限打服务器）。
//
// YUK-1483：轮询不靠 effect。每个 run 一个就地的轮询资源（JudgeRunPoller），持有真实
// 快照（status/result/error/polls/settled）和唯一的 timer；React 经 useSyncExternalStore
// 订阅它——有订阅且 enabled 时才轮询，退订即停（卸载后不再读）。到终态（或错误停机）时
// 资源对本 run 只回调一次 onSettled，宿主在回调里认领终态，而不是用 effect 盯快照推进。
// 没用 TanStack Query 的 refetchInterval：它首次立即请求、按固定 setInterval 而非「上次
// 响应后」计时、默认后台暂停，且没有「连续失败 N 次停机、成功即清零」的计数，保不住既有
// 的起步延迟、退避与停机上限。

import { useCallback, useState, useSyncExternalStore } from 'react';

import { apiJson } from '@/ui/lib/api';

export type JudgeRunPollStatus = 'queued' | 'started' | 'done' | 'failed';

/** JudgeRunTerminalResultSchema 的 UI 侧最小投影（passthrough 字段不逐一建模）。 */
export interface JudgeRunTerminalResult {
  attempt_event_id?: string;
  status?: 'effective' | 'review_required';
  assessment?: {
    submission_id: string;
    evaluation_group_id: string;
    candidate_id: string;
    original_evaluation_id?: string | null;
    effective_evaluation_id?: string | null;
  };
  judge_event_id?: string | null;
  coarse_outcome?: string;
  feedback_md?: string;
  route?: string | null;
  score?: number | null;
  confidence?: number;
  [key: string]: unknown;
}

export interface JudgeRunStatusWire {
  run_id: string;
  status: JudgeRunPollStatus;
  result: JudgeRunTerminalResult | null;
}

export interface JudgeRunPollingState {
  status: JudgeRunPollStatus | null;
  result: JudgeRunTerminalResult | null;
  /** 连续拉取失败超过上限后非 null；瞬断时保持 null（继续轮询）。 */
  error: Error | null;
  /** 已完成的轮询次数（测试可断言「同一 run 在持续查询」）。 */
  polls: number;
  /** true = 已到终态（done/failed）或错误停机。 */
  settled: boolean;
}

export interface UseJudgeRunPollingOptions {
  /** 202 回执的 run_id；null = 不轮询。 */
  runId: string | null;
  /** 202 回执 backfill.poll_url；缺席时按 run_id 推导默认路径。 */
  pollUrl?: string | null;
  /** 注入的状态读取（如 Start RPC）；提供时不再按 pollUrl 发 HTTP。 */
  readStatus?: (runId: string) => Promise<JudgeRunStatusWire>;
  /** 起步间隔 ms（默认 1200）。 */
  intervalMs?: number;
  /** 退避上限 ms（默认 6000）。 */
  maxIntervalMs?: number;
  /** 连续失败停机阈值（默认 5）。 */
  maxConsecutiveErrors?: number;
  enabled?: boolean;
  /**
   * 本 run 到终态（done/failed）或错误停机时调用，每个 run 至多一次。宿主在这里认领
   * 终态（推进下一题、揭晓反馈），不要在渲染里根据快照推进。
   */
  onSettled?: (state: JudgeRunPollingState) => void;
}

const IDLE: JudgeRunPollingState = {
  status: null,
  result: null,
  error: null,
  polls: 0,
  settled: false,
};
const idleSnapshot = () => IDLE;
const noopUnsubscribe = () => {};

interface PollerConfig {
  runId: string;
  url: string;
  intervalMs: number;
  maxIntervalMs: number;
  maxConsecutiveErrors: number;
}

interface PollerConnection {
  read?: (runId: string) => Promise<JudgeRunStatusWire>;
  onSettled?: (state: JudgeRunPollingState) => void;
}

function configKey(c: PollerConfig): string {
  return [c.runId, c.url, c.intervalMs, c.maxIntervalMs, c.maxConsecutiveErrors].join('\n');
}

// One run's polling resource. Constructing it has no side effects; polling starts only when
// a subscriber connects with enabled=true and stops when it disconnects. The snapshot is
// replaced (never mutated) on each change, so getSnapshot is a plain cached read.
class JudgeRunPoller {
  readonly key: string;
  private snapshot: JudgeRunPollingState = IDLE;
  private listener: (() => void) | null = null;
  private connection: PollerConnection | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every stop: a response that lands after a stop belongs to a dead loop.
  private loop = 0;
  private running = false;
  private nextDelay: number;
  private consecutiveErrors = 0;
  private settledDelivered = false;
  // Set by a disconnect, cleared if React reconnects in the same commit (a new subscribe
  // identity because enabled/onSettled/read changed, or a StrictMode re-subscribe). The
  // timer and any in-flight read then survive instead of restarting the backoff.
  private stopPending = false;

  constructor(private readonly config: PollerConfig) {
    this.key = configKey(config);
    this.nextDelay = config.intervalMs;
  }

  getSnapshot = (): JudgeRunPollingState => this.snapshot;

  connect(listener: () => void, enabled: boolean, connection: PollerConnection): () => void {
    this.listener = listener;
    this.connection = connection;
    this.stopPending = false;
    if (!enabled) this.stop();
    else if (!this.running) this.start();
    else this.deliverSettled();
    return () => {
      if (this.listener === listener) this.listener = null;
      this.stopPending = true;
      queueMicrotask(() => {
        if (!this.stopPending) return;
        this.stopPending = false;
        this.connection = null;
        this.stop();
      });
    };
  }

  private start() {
    if (this.snapshot.settled) {
      this.deliverSettled();
      return;
    }
    this.running = true;
    this.schedule(this.loop, this.nextDelay);
  }

  private stop() {
    this.running = false;
    this.loop += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(loop: number, delay: number) {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(loop, delay);
    }, delay);
  }

  private async tick(loop: number, delay: number) {
    const { runId, url, maxIntervalMs, maxConsecutiveErrors } = this.config;
    try {
      const read = this.connection?.read;
      const wire = read ? await read(runId) : await apiJson<JudgeRunStatusWire>(url);
      if (this.loop !== loop) return;
      this.consecutiveErrors = 0;
      const terminal = wire.status === 'done' || wire.status === 'failed';
      this.publish({
        status: wire.status,
        result: wire.result,
        error: null,
        polls: this.snapshot.polls + 1,
        settled: terminal,
      });
      if (terminal) {
        this.running = false;
        this.deliverSettled();
        return;
      }
    } catch (err) {
      if (this.loop !== loop) return;
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= maxConsecutiveErrors) {
        this.running = false;
        this.publish({ ...this.snapshot, error: err as Error, settled: true });
        this.deliverSettled();
        return;
      }
    }
    this.nextDelay = Math.min(delay * 1.5, maxIntervalMs);
    this.schedule(loop, this.nextDelay);
  }

  private publish(next: JudgeRunPollingState) {
    this.snapshot = next;
    this.listener?.();
  }

  private deliverSettled() {
    if (!this.snapshot.settled || this.settledDelivered) return;
    const onSettled = this.connection?.onSettled;
    if (!onSettled) return;
    this.settledDelivered = true;
    onSettled(this.snapshot);
  }
}

export function useJudgeRunPolling({
  runId,
  pollUrl,
  readStatus,
  intervalMs = 1200,
  maxIntervalMs = 6000,
  maxConsecutiveErrors = 5,
  enabled = true,
  onSettled,
}: UseJudgeRunPollingOptions): JudgeRunPollingState {
  const config: PollerConfig | null = runId
    ? {
        runId,
        url: pollUrl ?? `/api/jobs/judge_run/${encodeURIComponent(runId)}/status`,
        intervalMs,
        maxIntervalMs,
        maxConsecutiveErrors,
      }
    : null;
  const key = config ? configKey(config) : null;
  // runId 变化（换了一次 submission）→ 换一个新的轮询资源，快照从零开始；旧 run 的迟到
  // 响应只落在旧资源上，写不到新 run 的态。资源由渲染派生（构造无副作用）。
  const [poller, setPoller] = useState<JudgeRunPoller | null>(() =>
    config ? new JudgeRunPoller(config) : null,
  );
  let current = poller;
  if ((poller?.key ?? null) !== key) {
    current = config ? new JudgeRunPoller(config) : null;
    setPoller(current);
  }

  const subscribe = useCallback(
    (listener: () => void) =>
      current
        ? current.connect(listener, enabled, { read: readStatus, onSettled })
        : noopUnsubscribe,
    [current, enabled, readStatus, onSettled],
  );
  const getSnapshot = current ? current.getSnapshot : idleSnapshot;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
