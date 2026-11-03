// Durable judge_run event contract and status derivation.
//
// Events are replayed from job_events, the source of truth. The event vocabulary has one
// extra member, attempt_failed, for a delivery failure with retries left; it is non-terminal
// and the reducer treats it like started. Only done/failed end a run.
// Kept dependency-light for manifest eager imports; no DB client.

import { z } from 'zod';

/** job_events.business_table 标签——这一族 durable judge run 事件的归属键。 */
export const JUDGE_RUN_TABLE = 'judge_run' as const;

// job_events 是 free-form event_type（不经 domain parseEvent union）。这些是本族
// 的事件 type 契约——SSE 客户端 + 状态派生 + 回填消费者读这套词表。
export const JUDGE_RUN_EVENTS = {
  /** enqueue 落地后、handler 拾起前的初态（submit dispatch 写）。 */
  QUEUED: 'judge_run.queued',
  /** handler 拾起、判分调用启动前。 */
  STARTED: 'judge_run.started',
  /**
   * **非终态**：一次投递失败，但重投预算未耗尽（pg-boss 会再送一次）。
   *
   * W4 #TtWiB — 之前这里只有终态 FAILED，可重试失败也写它；而 FAILED 在本词表与
   * reducer 里都是**终态**，poll/SSE 客户端据此合理地停止等待并报失败，尽管 pg-boss
   * 已排好重投、下一次很可能写出 DONE。故拆出这条非终态痕迹：留下失败证据（可观测、
   * 可 SSE 展示「重试中」），但不把 run 判死。
   */
  ATTEMPT_FAILED: 'judge_run.attempt_failed',
  /** 终态：成功。payload 携 JudgeResultV2 + telemetry（回填消费者读它换真判词）。 */
  DONE: 'judge_run.done',
  /**
   * **终态**：失败且不会再有下一次投递——重投预算耗尽（进 DLQ）或非重试类失败
   * （未知面 / 题缺失 / 坏 payload）。last-writer wins。
   */
  FAILED: 'judge_run.failed',
  /**
   * **非终态**： A3 的 reconcile sweeper 为一条「作答已录、判词未落」的 pending
   * attempt 重新投递了一个 judge_run job。
   *
   * 它把 run 拉回 `queued`——这是诚实的：确实有一次全新的投递在飞。不这样做的话，先前
   * 那条终态 FAILED 会一直压着，poll/SSE 客户端据此停止等待，而队列里正跑着可能写出
   * DONE 的那次重投——与 #TtWiB 修掉的是同一个谎。
   *
   * payload 携 `{ delivery_id, attempt }`：`attempt` 是本 run 已发生的第几次恢复重投，sweeper
   * 用它封顶恢复次数（超过即停手，转人工，D6「manual-only, 先观察真实 DLQ 流量」）。
   */
  REQUEUED: 'judge_run.requeued',
} as const;

export type JudgeRunEventType = (typeof JUDGE_RUN_EVENTS)[keyof typeof JUDGE_RUN_EVENTS];

/** Runtime contract for the recovery marker shared by the sweeper, poll route, and reducer. */
export const JudgeRunRequeuedPayloadSchema = z
  .object({
    delivery_id: z.string().min(1).optional(),
    /** Legacy producer field retained only so existing markers remain readable. */
    job_id: z.string().min(1).optional(),
    attempt: z.number().int().positive().optional(),
  })
  .passthrough()
  .refine((payload) => payload.delivery_id !== undefined || payload.job_id !== undefined, {
    message: 'requeued marker requires delivery_id',
  });

/**
 * 派生状态。terminal（done/failed）一旦出现即锁定 last-writer-wins；否则按已见的
 * 最新非终态事件推进 queued → started。空序列 → 'queued'（enqueue 即写 queued，
 * 但消费者可能在 queued 事件到达前先订阅 → 给最保守的初态）。
 */
export type JudgeRunStatus = 'queued' | 'started' | 'done' | 'failed';

/** replay 事件的最小读取形（只看 event_type，与 copilot-run-status 同型）。 */
export interface JudgeRunStatusEvent {
  event_type: string;
  payload?: unknown;
}

/**
 * 从 replay/live 事件序列派生 run 状态。终态（done/failed）last-writer wins——
 * 一次失败痕迹后又有成功（跨 provider 重投改判）则以成功为终态，反之亦然。无终态
 * 时取已见过的最高非终态阶段。纯 + 无依赖。
 */
export function deriveJudgeRunStatus(events: JudgeRunStatusEvent[]): JudgeRunStatus {
  let status: JudgeRunStatus = 'queued';
  let terminalDeliveryId: string | null = null;
  let startedDeliveryId: string | null = null;
  for (const e of events) {
    const deliveryId = readDeliveryId(e.payload);
    switch (e.event_type) {
      case JUDGE_RUN_EVENTS.DONE:
        status = 'done';
        terminalDeliveryId = deliveryId;
        break;
      case JUDGE_RUN_EVENTS.FAILED:
        status = 'failed';
        terminalDeliveryId = deliveryId;
        break;
      case JUDGE_RUN_EVENTS.STARTED:
        // Legacy/direct producers may omit delivery identity. Keep the last known identity so
        // a causally-late REQUEUED marker for that same delivery cannot rewind started → queued.
        if (deliveryId !== null) startedDeliveryId = deliveryId;
        if (status === 'queued') status = 'started';
        break;
      case JUDGE_RUN_EVENTS.ATTEMPT_FAILED:
        // W4 #TtWiB — **非终态**。一次投递失败但重投还在预算内 ⇒ run 仍在飞，客户端
        // 必须继续等（下一次投递可能写 DONE）。与 STARTED 同级：把 queued 推到 started
        // （确实已经跑过一次了），绝不推向 failed——只有终态 FAILED 能判死。
        // Legacy/direct callers may omit delivery identity. Preserve the STARTED delivery we
        // already know instead of replacing it with null; a late same-delivery REQUEUED marker
        // must not rewind started → queued.
        if (deliveryId !== null) startedDeliveryId = deliveryId;
        if (status === 'queued') status = 'started';
        break;
      case JUDGE_RUN_EVENTS.QUEUED:
        // 初态；不覆盖已推进的阶段。
        break;
      case JUDGE_RUN_EVENTS.REQUEUED:
        // Enqueue precedes this marker, so a fast worker can terminalize first. Matching delivery
        // identity makes that marker causally old; a different id is a genuine later recovery.
        if (
          deliveryId !== null &&
          deliveryId !== terminalDeliveryId &&
          deliveryId !== startedDeliveryId
        ) {
          status = 'queued';
          terminalDeliveryId = null;
          startedDeliveryId = null;
        }
        break;
      default:
        // 未知 event_type：忽略（forward-compat）。
        break;
    }
  }
  return status;
}

function readDeliveryId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const value = record.delivery_id ?? record.job_id;
  return typeof value === 'string' ? value : null;
}

/** replay 事件（读取形带 payload），用于从终态事件抽出判词回填结果。 */
export interface JudgeRunReplayEvent {
  event_type: string;
  payload: unknown;
}

/**
 * 从 replay 序列抽出终态判词 payload（poll `.../status` 与回填消费者用）。返回
 * 最后一条 DONE 的 payload（携 JudgeResultV2 + telemetry），无成功终态 → null。
 * DONE last-writer wins（与 deriveJudgeRunStatus 同律：重投改判成功盖旧痕迹）。
 */
export function terminalJudgeRunResult(events: JudgeRunReplayEvent[]): unknown {
  let result: unknown = null;
  for (const e of events) {
    if (e.event_type === JUDGE_RUN_EVENTS.DONE) result = e.payload;
  }
  return result;
}

/** A native submission has exactly one durable judge run; dispatch and recovery reads derive it here. */
export function nativeJudgeRunId(submissionId: string): string {
  return `judge_native_${submissionId}`;
}

/** The poll URL the 202 receipt and the issuance recovery read both hand to the client. */
export function judgeRunPollUrl(runId: string): string {
  return `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/status`;
}
