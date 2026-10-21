// durable copilot run 的事件契约 + 状态派生。
//
// run handle = checkpoint_id = user_ask event id（run_id）。状态不落瘦表，而是
// 从 `job_events`（business_table='copilot_run', business_id=run_id）的 replay
// 末事件派生——`job_events` 即 SoT。

/** job_events.business_table 标签。 */
export const COPILOT_RUN_TABLE = 'copilot_run' as const;

// job_events 是 free-form event_type（不经 domain parseEvent union）。下面的词表
// 是本族事件 type 契约，SSE 客户端与状态派生共用。
export const COPILOT_RUN_EVENTS = {
  /** enqueue 落地后、handler 拾起前的初态（route dispatch 写）。 */
  QUEUED: 'copilot_run.queued',
  /** Session head 的物理 pg-boss job 与此事件在同一事务内提交。 */
  DISPATCHED: 'copilot_run.dispatched',
  /** handler 拾起、SDK run 启动前。 */
  STARTED: 'copilot_run.started',
  /** deterministic setup 完成、紧邻 paid model/tool gateway 的 at-most-once fence。 */
  EXECUTION_STARTED: 'copilot_run.execution_started',
  /** 回合/进度心跳（工具步进等；forward-compat 进度槽）。 */
  STEP: 'copilot_run.step',
  /** Root provider prose increments. Nonterminal; REPLY/FAILED authoritatively replaces the draft. */
  DELTA: 'copilot_run.delta',
  /** 终稿 reply 文本就位（done 的前序，分开以便流式消费者先渲染 reply 再收 done）。 */
  REPLY: 'copilot_run.reply',
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
 * other FAILED payload is fail-closed terminal: retry semantics require explicit
 * opt-in, so a producer cannot accidentally buy another paid model/tool run.
 */
export function isCopilotRunTerminalFailureReason(value: unknown): boolean {
  return value !== 'error';
}

export type CopilotRunEventType = (typeof COPILOT_RUN_EVENTS)[keyof typeof COPILOT_RUN_EVENTS];

/**
 * 派生状态。终态（done/failed）事件 last-writer-wins，非终态事件不能覆盖；否则按已见的最新非终态
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
 * 无终态时取已见过的最高非终态阶段。空序列 → 'queued'（消费者可能在 queued
 * 事件到达前先订阅）。cancel_requested 是浮动的协作状态，直到 worker 投影出
 * FAILED(cancelled)；先前已提交的 DONE/终态 FAILED 优先。
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
      case COPILOT_RUN_EVENTS.DELTA:
        // STEP / REPLY / DELTA are non-terminal "run is going" signals, ranked
        // above started. While non-terminal they push to 'running'
        // unconditionally, even when STARTED was lost or arrived out of order.
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
