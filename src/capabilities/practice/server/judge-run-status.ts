// YUK-594 (durable judge main path, W1) — durable judge_run 的事件契约 + 状态派生。
//
// 蓝本：copilot-run-status.ts（YUK-364/575）。judge_run 是 copilot_run 的更薄
// 同胞——单次无状态 LLM 判分调用，无对话记忆 / 无工具循环 / 无取消 chip 语义，
// 故词表与 reducer 都更简：queued → started → done|failed。（#12 — 蓝本 copilot_run
// 有 `running` 中间态，judge_run **没有**：单次调用无「工具循环进行中」阶段可报，
// JudgeRunStatus / JUDGE_RUN_EVENTS / handler 三处都不产 running。）
//
// **事件 ≠ 状态**（W4 #TtWiB）：事件词表比状态多一条 `attempt_failed`——一次投递失败
// 但重投预算未耗尽。它是**非终态**痕迹（reducer 视同 started），只有 done / failed
// 能终结 run。状态枚举因此不变：客户端看到 attempt_failed 可以显示「重试中」，但绝
// 不能据此停止等待。
//
// run handle = judge_run id（W2 submit 面：= 该次作答 attempt/outcome event id，
// 见 submit.ts enqueueDurableJudge）。状态不落瘦表，而是从 `job_events`
// （business_table='judge_run', business_id=run_id）的 replay 末事件派生——
// job_events 即 SoT，与 copilot_run / ingestion / echo 同型。
//
// 纯函数 + 无 DB 依赖（unit 分区）：仿 copilot-run-status.ts / ingestion-phase.ts
// 的「从 replay 末事件派生」做法，unit-tested in judge-run-status.test.ts。此模块
// 也承载 poll-tier 响应 schema（dependency-light，供 manifest 静态导入而不牵入
// db/client——route 文件本体带 db 依赖，不可被 manifest eager-import）。

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
   * **非终态**：YUK-777 A3 的 reconcile sweeper 为一条「作答已录、判词未落」的 pending
   * attempt 重新投递了一个 judge_run job。
   *
   * 它把 run 拉回 `queued`——这是诚实的：确实有一次全新的投递在飞。不这样做的话，先前
   * 那条终态 FAILED 会一直压着，poll/SSE 客户端据此停止等待，而队列里正跑着可能写出
   * DONE 的那次重投——与 #TtWiB 修掉的是同一个谎。
   *
   * payload 携 `{ job_id, attempt }`：`attempt` 是本 run 已发生的第几次恢复重投，sweeper
   * 用它封顶恢复次数（超过即停手，转人工，D6「manual-only, 先观察真实 DLQ 流量」）。
   */
  REQUEUED: 'judge_run.requeued',
} as const;

export type JudgeRunEventType = (typeof JUDGE_RUN_EVENTS)[keyof typeof JUDGE_RUN_EVENTS];

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
        if (status === 'queued') status = 'started';
        break;
      case JUDGE_RUN_EVENTS.ATTEMPT_FAILED:
        // W4 #TtWiB — **非终态**。一次投递失败但重投还在预算内 ⇒ run 仍在飞，客户端
        // 必须继续等（下一次投递可能写 DONE）。与 STARTED 同级：把 queued 推到 started
        // （确实已经跑过一次了），绝不推向 failed——只有终态 FAILED 能判死。
        if (status === 'queued') status = 'started';
        break;
      case JUDGE_RUN_EVENTS.QUEUED:
        // 初态；不覆盖已推进的阶段。
        break;
      case JUDGE_RUN_EVENTS.REQUEUED:
        // Enqueue precedes this marker, so a fast worker can terminalize first. Matching delivery
        // identity makes that marker causally old; a different id is a genuine later recovery.
        if (deliveryId !== null && deliveryId !== terminalDeliveryId) {
          status = 'queued';
          terminalDeliveryId = null;
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
  const value = (payload as Record<string, unknown>).delivery_id;
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

/**
 * 终态 DONE 判词 payload 的结构化形（judge_run handler 写、poll/SSE 回填读）。字段
 * 全 optional + passthrough：不同判分路由携不同子集（coarse_outcome/score/feedback），
 * 且 already_persisted 恢复路径可能只带最小集——passthrough 保 forward-compat。
 */
export const JudgeRunTerminalResultSchema = z
  .object({
    attempt_event_id: z.string(),
    judge_event_id: z.string().nullable().optional(),
    outcome: z.string().optional(),
    final_rating: z.string().optional(),
    route: z.string().nullable().optional(),
    coarse_outcome: z.string().optional(),
    score: z.number().nullable().optional(),
    // W5 #Tunnw — `score` is uninterpretable without its meaning (steps / unit_dimension carry
    // different score semantics), and `evidence_json` is what a client renders to SHOW the
    // judge's reasoning. Both were dropped from the terminal contract, so SSE/poll consumers —
    // and the crash-recovery path, which can only return what this contract carries — saw a
    // bare number with no way to explain it.
    score_meaning: z.string().optional(),
    evidence_json: z.unknown().optional(),
    confidence: z.number().optional(),
    feedback_md: z.string().optional(),
    capability_ref: z.object({ id: z.string(), version: z.string() }).optional(),
    telemetry: z.unknown().optional(),
    /** The override this handler REQUESTED — not necessarily the lane that executed (#Tunn0). */
    provider_override: z.string().nullable().optional(),
    // W5 #Tunn0 — the RESOLVED execution lane, read off the invoker's `kind:'invoked'`
    // provenance. With a global AI_PROVIDER_OVERRIDE set, a run executes on a non-default lane
    // while `provider_override` is null, so same-lane calibration keyed on the latter
    // mis-attributes every run. These three are the execution truth.
    provider: z.string().optional(),
    model: z.string().optional(),
    task_run_id: z.string().optional(),
    /** W5 — verdict landed, but derived writes were skipped (newer evidence already existed). */
    late_arrival: z.boolean().optional(),
    already_persisted: z.boolean().optional(),
  })
  .passthrough();

/**
 * poll-tier `GET /api/jobs/judge_run/[id]/status` 响应 schema。放在此 dependency-light
 * 模块（非 route 文件）以便 manifest 静态导入而不 eager-import route 的 db 依赖。
 *
 * #13 — `result` 与 `status` 的耦合由 **discriminated union 在 schema 里表达**（旧形是
 * 平铺 object + 注释约定，schema 允许 `status:'queued'` 携非 null result，codegen/客户端
 * 看不到这条不变量）：
 *   - `status:'done'` → result 是结构化判词；**仍 nullable**，因为 route 对畸形/legacy
 *     DONE payload 做 safeParse 降级（#7 现在会 warn 记录），那一路诚实地报 done+null，
 *     不该被契约判违规。
 *   - `queued|started|failed` → result 恒 null（无判词可给）。
 */
export const JudgeRunStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({
    run_id: z.string(),
    status: z.literal('done'),
    result: JudgeRunTerminalResultSchema.nullable(),
  }),
  z.object({
    run_id: z.string(),
    status: z.enum(['queued', 'started', 'failed']),
    result: z.null(),
  }),
]);

/**
 * 202-pending 契约响应 schema（submit 面 async-main 分流时返回）。登记进 submit
 * 路由的 manifest responses[202] 让 assertApiRouteSuccessStatus 放行 202（否则
 * flag-on 的 202 被拒）。dependency-light（此模块），供 manifest 静态导入。
 */
export const JudgeDurablePendingResponseSchema = z.object({
  run_id: z.string(),
  verdict: z.literal('pending'),
  backfill: z.object({
    channel: z.literal('sse'),
    url: z.string(),
    poll_url: z.string(),
  }),
});
