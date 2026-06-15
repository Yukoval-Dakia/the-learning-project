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
  /** 回合/进度心跳（v1 单 SDK run 内不细分，保留为 forward-compat 进度槽）。 */
  STEP: 'copilot_run.step',
  /** 终稿 reply 文本就位（done 的前序，分开以便流式消费者先渲染 reply 再收 done）。 */
  REPLY: 'copilot_run.reply',
  /** 终态：成功。 */
  DONE: 'copilot_run.done',
  /** 终态：失败（含 cancelled）。 */
  FAILED: 'copilot_run.failed',
  /** 协作取消请求（启动前查；v1 不做 live-steer，回合间早停）。 */
  CANCEL_REQUESTED: 'copilot_run.cancel_requested',
} as const;

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

/** replay 事件的最小读取形（只看 event_type，与 ingestion-phase PhaseEvent 同型）。 */
export interface CopilotRunStatusEvent {
  event_type: string;
}

/**
 * 从 replay/live 事件序列派生 run 状态。终态（done/failed）last-writer wins；
 * 无终态时取已见过的最高非终态阶段。空序列 → 'queued'（enqueue 即写 queued，
 * 但消费者在 queued 事件到达前可能先订阅 → 给最保守的初态）。
 *
 * 纯 + 无依赖：unit-tested in copilot-run-status.test.ts。
 *
 * YUK-364 (defer) — cancel_requested 的 float 语义、以及 reconnect 时 started-vs-
 * running 的边界，是消费端 run-card UI（后续 lane）才真正用到的呈现细节。当前无
 * UI 消费者，这些边角语义留待消费端 lane 落地时按真实需求校准，不在本 lane 收口。
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
        status = 'failed';
        terminal = true;
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

/** 在 replay 序列里是否已出现取消请求（handler 启动前的早停判据）。 */
export function hasCancelRequest(events: CopilotRunStatusEvent[]): boolean {
  return events.some((e) => e.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED);
}
