// YUK-364 (ADR-0041 endurance W1 L2) — durable copilot run 的事件契约 + 状态派生。
//
// run handle = checkpoint_id = user_ask event id（run_id）。状态不落瘦表，而是
// 从 `job_events`（business_table='copilot_run', business_id=run_id）的 replay
// 末事件派生——`job_events` 即 SoT，与 ingestion / echo 同型（裁决：能不加表就
// 不加，event log 已是 SoT；run card 订阅 UI 是后续 lane，当前无表的消费者）。
//
// 纯函数 + 无 DB 依赖（unit 分区）：仿 src/ui/lib/ingestion-phase.ts
// derivePhaseFromEvents 的同型「从 replay 末事件派生 phase」做法。

/** job_events.business_table 标签——这一族 durable copilot run 事件的归属键。 */
export const COPILOT_RUN_TABLE = 'copilot_run' as const;

// job_events 是 free-form event_type（不经 domain parseEvent union，见
// src/server/events/writer.ts / ingestion-progress.ts NOTE）。这些是本族的
// 事件 type 契约——SSE 客户端 + 状态派生读这套词表。
export const COPILOT_RUN_EVENTS = {
  /** enqueue 落地后、handler 拾起前的初态（route dispatch 写）。 */
  QUEUED: 'copilot_run.queued',
  /** handler 拾起、SDK run 启动前。 */
  STARTED: 'copilot_run.started',
  /** deterministic setup 完成、紧邻 paid model/tool gateway 的 at-most-once fence。 */
  EXECUTION_STARTED: 'copilot_run.execution_started',
  /** 回合/进度心跳（工具步进等；v1 保留为 forward-compat 进度槽）。 */
  STEP: 'copilot_run.step',
  /**
   * YUK-575/YUK-832 — 文本增量。durable handler 先缓冲 candidate；最终证据审阅后，
   * marker 记下是否有正文，settlement projection 再把一条 reviewed full-text delta 与
   * REPLY/DONE 或 FAILED 同事务写入（严格在 terminal 前且可由 redelivery 修复）。非终态。
   */
  DELTA: 'copilot_run.delta',
  /** 终稿 reply 文本就位（done 的前序，分开以便流式消费者先渲染 reply 再收 done）。 */
  REPLY: 'copilot_run.reply',
  /** 终态：成功。 */
  DONE: 'copilot_run.done',
  /** 终态：失败（含 cancelled）。 */
  FAILED: 'copilot_run.failed',
  /** 协作取消请求（启动前 fence guard + 运行中 poll/hook/tool gate 共同观察）。 */
  CANCEL_REQUESTED: 'copilot_run.cancel_requested',
} as const;

/** Known FAILED reasons that permanently settle a run rather than one retry attempt. */
export const COPILOT_RUN_TERMINAL_FAILURE_REASONS = [
  'cancelled',
  'exhausted',
  'enqueue_failed',
  'ambiguous_execution',
  'pre_execution_lost',
] as const;

/**
 * Legacy `reason=error` frames describe one retryable delivery attempt. Every
 * other FAILED payload is fail-closed terminal: a future producer must opt in
 * explicitly to retry semantics rather than accidentally buying another paid
 * model/tool execution.
 */
export function isCopilotRunTerminalFailureReason(value: unknown): boolean {
  return value !== 'error';
}

export type CopilotRunEventType = (typeof COPILOT_RUN_EVENTS)[keyof typeof COPILOT_RUN_EVENTS];

/**
 * 派生状态。terminal（done/failed）一旦出现即锁定；否则按已见的最新非终态
 * 事件推进 queued → started → running。cancel_requested 是「请求」非终态——
 * 真正的终止由 handler 写 failed(reason:cancelled) 体现。
 */
export type CopilotRunStatus =
  | 'queued'
  | 'started'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancel_requested';

/** replay 事件的最小读取形。FAILED 需读 reason 区分 retry frame 与终态。 */
export interface CopilotRunStatusEvent {
  event_type: string;
  payload?: unknown;
}

function failureReason(event: CopilotRunStatusEvent): unknown {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>).reason;
}

/** One canonical in-memory terminal predicate shared by status and settlement. */
export function isCopilotRunTerminalEvent(event: CopilotRunStatusEvent): boolean {
  return (
    event.event_type === COPILOT_RUN_EVENTS.DONE ||
    (event.event_type === COPILOT_RUN_EVENTS.FAILED &&
      isCopilotRunTerminalFailureReason(failureReason(event)))
  );
}

/**
 * 从 replay/live 事件序列派生 run 状态。终态（done/failed）last-writer wins；
 * 无终态时取已见过的最高非终态阶段。空序列 → 'queued'（enqueue 即写 queued，
 * 但消费者在 queued 事件到达前可能先订阅 → 给最保守的初态）。
 *
 * 纯 + 无依赖：unit-tested in copilot-run-status.test.ts。
 *
 * cancel_requested remains a floating cooperative state until the worker
 * projects FAILED(cancelled); a previously committed DONE/terminal FAILED wins.
 * Reconnect presentation remains a later UI lane.
 */
export function deriveCopilotRunStatus(events: CopilotRunStatusEvent[]): CopilotRunStatus {
  let status: CopilotRunStatus = 'queued';
  let terminal = false;
  let cancelRequested = false;
  for (const e of events) {
    switch (e.event_type) {
      case COPILOT_RUN_EVENTS.DONE:
        status = 'done';
        terminal = true;
        break;
      case COPILOT_RUN_EVENTS.FAILED:
        // Historical FAILED(reason=error) is one failed pg-boss attempt. The
        // same run may legitimately emit STARTED/DELTA/DONE on redelivery.
        if (isCopilotRunTerminalEvent(e)) {
          status = 'failed';
          terminal = true;
        }
        break;
      case COPILOT_RUN_EVENTS.CANCEL_REQUESTED:
        // 标记取消请求；不立即终态——若后续有 done/failed 则以那个为准。
        cancelRequested = true;
        break;
      case COPILOT_RUN_EVENTS.STARTED:
        // 「取最高非终态阶段」：STARTED 把 queued 推到 started；若已 running（STEP/
        // REPLY 先到，乱序/丢 STARTED）则不回退。
        if (!terminal && status === 'queued') status = 'started';
        break;
      case COPILOT_RUN_EVENTS.STEP:
      case COPILOT_RUN_EVENTS.REPLY:
      case COPILOT_RUN_EVENTS.EXECUTION_STARTED:
      // YUK-575 (N2) — DELTA（流式文本增量）是「run 正在跑」的非终态信号，与 STEP/REPLY
      // 同级推到 'running'。
      case COPILOT_RUN_EVENTS.DELTA:
        // CodeRabbit fix — STEP（进度心跳）/ REPLY（终稿就位）是「run 正在跑」的明确
        // 信号，语义上高于 started。原逻辑 `status==='queued' ? 'started' : 'running'`
        // 会把「STEP/REPLY 首次出现但还没见过 STARTED」（如 [STEP] 或 [QUEUED, REPLY]，
        // STARTED 乱序/丢失）错误降级为 'started'。修正：非终态时 STEP/REPLY 无条件
        // 推到 'running'（与「取最高非终态阶段」一致）。
        if (!terminal) status = 'running';
        break;
      case COPILOT_RUN_EVENTS.QUEUED:
        if (!terminal && status === 'queued') status = 'queued';
        break;
      default:
        // 未知 event_type：忽略（forward-compat）。
        break;
    }
  }
  // cancel_requested 只在尚未到达真正终态时浮出（终态优先）。
  if (!terminal && cancelRequested) return 'cancel_requested';
  return status;
}

/** 在 replay 序列里是否已出现取消请求（fence、settlement 与 replay 共享判据）。 */
export function hasCancelRequest(events: CopilotRunStatusEvent[]): boolean {
  return events.some((e) => e.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED);
}
