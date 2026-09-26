// YUK-1051 — 202-pending 的「同一次 submission 继续查询」poll hook。
//
// 契约（submit.ts durablePendingResponse）：202 body 带 { run_id, verdict:'pending',
// backfill: { channel:'sse', url, poll_url } }。本 hook 只轮询 poll_url（GET 纯读），
// 直到终态（done/failed）——**永不重交同一答案**；SSE 主通道由宿主另行接入时，
// 两者读同一个 run_id，互不冲突。
//
// 轮询策略：固定起步间隔 + 温和退避（×1.5，封顶），终态/卸载/换 run 即停；
// 连续错误超阈值（默认 5 次）停机并把 error 交给宿主（不无限打服务器）。

import { useEffect, useRef, useState } from 'react';

import { apiJson } from '@/ui/lib/api';

export type JudgeRunPollStatus = 'queued' | 'started' | 'done' | 'failed';

/** JudgeRunTerminalResultSchema 的 UI 侧最小投影（passthrough 字段不逐一建模）。 */
export interface JudgeRunTerminalResult {
  attempt_event_id?: string;
  judge_event_id?: string | null;
  coarse_outcome?: string;
  feedback_md?: string;
  route?: string | null;
  score?: number | null;
  confidence?: number;
  [key: string]: unknown;
}

interface JudgeRunStatusWire {
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
  /** 起步间隔 ms（默认 1200）。 */
  intervalMs?: number;
  /** 退避上限 ms（默认 6000）。 */
  maxIntervalMs?: number;
  /** 连续失败停机阈值（默认 5）。 */
  maxConsecutiveErrors?: number;
  enabled?: boolean;
}

export function useJudgeRunPolling({
  runId,
  pollUrl,
  intervalMs = 1200,
  maxIntervalMs = 6000,
  maxConsecutiveErrors = 5,
  enabled = true,
}: UseJudgeRunPollingOptions): JudgeRunPollingState {
  const [state, setState] = useState<JudgeRunPollingState>({
    status: null,
    result: null,
    error: null,
    polls: 0,
    settled: false,
  });

  // runId 变化（换了一次 submission）→ 归零重查；旧 run 的迟到响应绝不可写新 run 的态。
  const generationRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId change must re-run the reset effect even though it's only read via closure
  useEffect(() => {
    generationRef.current += 1;
    setState({ status: null, result: null, error: null, polls: 0, settled: false });
  }, [runId]);

  useEffect(() => {
    if (!enabled || !runId) return;
    const url = pollUrl ?? `/api/jobs/judge_run/${encodeURIComponent(runId)}/status`;
    const generation = generationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;
    const tick = async (delay: number) => {
      let nextDelay = delay;
      try {
        const wire = await apiJson<JudgeRunStatusWire>(url);
        if (cancelled || generationRef.current !== generation) return;
        consecutiveErrors = 0;
        const terminal = wire.status === 'done' || wire.status === 'failed';
        setState((s) => ({
          status: wire.status,
          result: wire.result,
          error: null,
          polls: s.polls + 1,
          settled: terminal,
        }));
        if (terminal) return;
      } catch (err) {
        if (cancelled || generationRef.current !== generation) return;
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          setState((s) => ({ ...s, error: err as Error, settled: true }));
          return;
        }
      }
      nextDelay = Math.min(delay * 1.5, maxIntervalMs);
      timer = setTimeout(() => void tick(nextDelay), nextDelay);
    };
    timer = setTimeout(() => void tick(intervalMs), intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, runId, pollUrl, intervalMs, maxIntervalMs, maxConsecutiveErrors]);
  return state;
}
