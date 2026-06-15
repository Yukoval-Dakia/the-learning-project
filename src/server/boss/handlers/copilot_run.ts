// YUK-364 (ADR-0041 endurance W1 L2) — durable copilot run handler。
//
// 把 copilot 从同步面（src/capabilities/copilot/server/chat.ts 的 inline
// streamTaskCollecting）桥到异步 durable pg-boss 面：route dispatch（durable
// 标记）→ boss.send('copilot_run', {...}) → 本 handler 在 worker 进程跑一个
// CopilotTask run，边跑边把进度/终稿写进 job_events，SSE 消费者经 computeReplay
// 订阅（消费端 UI 是后续 lane）。
//
// 蓝本：src/server/boss/handlers/quiz_gen.ts 的 runQuizGen——MCP mount
// (buildMcpServerFromRegistry) + ToolContext(causedByEventId=triggerEventId) +
// runAgentTask + 成功/失败 writeEvent。差别：本 handler 走 CopilotTask + copilot
// 工具全集 surface，进度落 job_events（writeJobEvent）而非 domain event 表，
// 不新增表（run handle = run_id = checkpoint_id = user_ask event id；状态从
// computeReplay 末事件派生，见 copilot-run-status.ts）。
//
// worker 零前置（grounding 2026-06-15，覆盖分支上 stale ADR §代价）：worker 每个
// AI job 经 buildMcpServerFromRegistry，其幂等 registerCoreTools() 把 CORE_TOOLS
// 全集填进本进程 registry，是 manifest union 的真超集 → 本 handler 走
// buildMcpServerFromRegistry 自动有 copilot 全集工具。不碰 start-worker.ts。

import type { Job } from 'pg-boss';

import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import type { Db } from '@/db/client';
import { runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';

// dispatch 入口投递的 job 体。run_id = checkpoint_id = user_ask event id（route
// 在 enqueue 前已写 user_ask domain event，本 handler 以它做 causedByEventId 让
// tool-use mirror 串到同一因果链，与 quiz_gen triggerEventId 同款）。
export interface CopilotRunJobData {
  /** checkpoint_id = user_ask event id；既是 run handle 也是 job_events business_id。 */
  run_id: string;
  user_message: string;
  /** 'chat' | 'chip'——决定 surface / actorRef（与同步面 selectSurface 同语义）。 */
  triggered_by: 'chat' | 'chip';
  /** chip 直触可选标识，透传进 run input（同步面 chip_kind）。 */
  chip_kind?: string;
}

// 同步面 selectSurface / selectActorRef 的 worker 侧镜像（chat.ts 里是模块私有
// 函数；durable 面在 worker 进程，内联同语义避免跨包导出私有 helper）。
function selectSurface(triggeredBy: CopilotRunJobData['triggered_by']) {
  return triggeredBy === 'chip'
    ? ('copilot_user_suggested_mistake_action' as const)
    : ('copilot' as const);
}
function selectActorRef(triggeredBy: CopilotRunJobData['triggered_by']) {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

export interface RunCopilotRunParams {
  db: Db;
  data: CopilotRunJobData;
  /** test seam — 默认 runAgentTask。 */
  runAgentTaskFn?: typeof runAgentTask;
  /** test seam — 默认 buildMcpServerFromRegistry。 */
  buildMcpServerFn?: typeof buildMcpServerFromRegistry;
}

export type RunCopilotRunResult =
  | { status: 'done'; reply: string; task_run_id: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

export async function runCopilotRun(params: RunCopilotRunParams): Promise<RunCopilotRunResult> {
  const { db, data } = params;
  const run = params.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = params.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const runId = data.run_id;
  const surface = selectSurface(data.triggered_by);
  const actorRef = selectActorRef(data.triggered_by);
  const taskRunId = `copilot_run_tool_${runId}`;

  // 启动前查协作取消（v1：回合间早停，不做 live-steer）。run handle 是 run_id，
  // 取消请求由别处写一条 copilot_run.cancel_requested 进同一 business_id；这里
  // 在跑昂贵 SDK run 之前 replay 一次，已请求则早停写 failed(cancelled)。
  const priorEvents = await computeReplay(db, {
    businessTable: COPILOT_RUN_TABLE,
    businessId: runId,
    lastEventId: 0,
  });
  if (priorEvents.some((e) => e.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED)) {
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: { reason: 'cancelled', cancelled_before_start: true },
    });
    return { status: 'cancelled' };
  }

  // started 心跳——消费者据此把 status 从 queued 推到 started。
  await writeJobEvent(db, {
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: COPILOT_RUN_EVENTS.STARTED,
    payload: { surface, triggered_by: data.triggered_by },
  });

  // ── MCP mount: 照 quiz_gen:415-425 / chat.ts:929-952 ──────────────────────
  // copilot 全集 surface（chat surface=copilot；chip surface=user-suggested）。
  // causedByEventId = run_id（= user_ask event id）：tool-use mirror 串到同一
  // 因果链（quiz_gen triggerEventId 同款）。
  const toolNames = resolveDomainToolNames(surface);
  const mcpServer = buildMcpServer({
    ctx: {
      db,
      taskRunId,
      callerActor: { kind: 'agent', ref: actorRef },
      causedByEventId: runId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames,
    taskKind: 'CopilotTask',
  });
  const mcpServers = { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer };
  const allowedTools = [...resolveMcpAllowedTools(surface)];

  // durable run 不带同步面的 conversation_history / proposal_feedback / ambient
  // （那些是 inline 路径的 per-message 装配，本 lane 不抬）。v1 最小 run input：
  // 与 CopilotTask registry 契约一致的 surface/triggered_by/user_message。
  const runInput = {
    surface,
    triggered_by: data.triggered_by,
    user_message: data.user_message,
    ...(data.chip_kind ? { chip_kind: data.chip_kind } : {}),
  };

  try {
    const result = await run('CopilotTask', runInput, { db, mcpServers, allowedTools });

    // 终稿 reply 事件（done 的前序：消费者可先渲染 reply 再收 done）。
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.REPLY,
      payload: { reply_md: result.text, task_run_id: result.task_run_id },
    });
    await writeJobEvent(db, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: { task_run_id: result.task_run_id, finish_reason: result.finishReason },
    });
    return { status: 'done', reply: result.text, task_run_id: result.task_run_id };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // 失败事件先写（终态可见），再 re-throw 让 pg-boss 走 DLQ/retry 配方（agent 档）。
    // best-effort：失败事件写入本身再失败也不能吞掉原始错误。
    try {
      await writeJobEvent(db, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: { reason: 'error', error: message },
      });
    } catch (writeErr) {
      console.error('[copilot_run] failed-event write failed for', runId, writeErr);
    }
    throw err;
  }
}

/**
 * pg-boss handler 工厂（JobHandlerFactory 形态 `(db) => (jobs) => Promise<void>`）。
 * 注册器（register-capability-jobs.ts）固定 { pollingIntervalSeconds:2, batchSize:1 }
 * → 天然 n=1 单线程一次一 run（串行化由 batchSize:1 提供）。
 */
export function buildCopilotRunHandler(db: Db): (jobs: Job<CopilotRunJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.run_id || !data?.user_message || !data?.triggered_by) {
        console.warn('[copilot_run] job missing run_id/user_message/triggered_by', job.id);
        continue;
      }
      const result = await runCopilotRun({ db, data });
      console.log(`[copilot_run] ${data.run_id} -> ${result.status}`);
    }
  };
}
