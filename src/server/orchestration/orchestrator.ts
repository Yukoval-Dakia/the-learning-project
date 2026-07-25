// YUK-758 — 夜间任务编排 orchestrator 驱动核心。
//
// 单锚点 cron 开闸 → 建「今晚运行记录」+ enqueue 根节点；每 tick 轮询节点终态、推进
// 就绪下游、跳过硬上游失败者，未完成则自调度下一 tick。执行仍走既有 pg-boss handler
// （orchestrator 只 boss.send 触发 + 轮询 boss.getJobById），业务代码零改动。
//
// 逐边失败语义：硬边（默认）——上游 failed/skipped → 下游 skipped（留 detail 痕迹）；
// 软边——上游未 succeeded 但硬上游齐 → 下游照跑，job payload 带 { stale: true }。

import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import {
  LAYER_STAGGER_MAX_SECONDS,
  LAYER_STAGGER_SECONDS,
  NODE_TIMEOUT_SECONDS,
  ORCHESTRATOR_QUEUE,
  SEND_RECOVERY_GRACE_SECONDS,
  TICK_INTERVAL_SECONDS,
} from './constants';
import {
  type NodeRow,
  type RunRow,
  type RunTrigger,
  claimNodePending,
  createRunWithNodes,
  finishRun,
  getActiveRunForDate,
  getLatestRunForDate,
  insertNodes,
  isTerminalNodeStatus,
  listActiveRuns,
  loadNodes,
  updateNodeStatus,
} from './store';

/** orchestrator 只需 pg-boss 的这两个能力——窄接口让 DB 测试注入 fake boss。 */
export interface OrchestratorBoss {
  /**
   * `options.id` 指定 job 主键（pg-boss `SendOptions.id`）——orchestrator 靠它做「意图先落库」：
   * 先把预生成 id 随 CAS 写进节点行再 send。pg-boss 的 job INSERT 是 `ON CONFLICT DO NOTHING`，
   * 故同 id 重发幂等（返回 null = 该 id 的 job 已存在，不是失败）。
   */
  send(
    name: string,
    data: object,
    options?: { startAfter?: number; id?: string },
  ): Promise<string | null>;
  getJobById(name: string, id: string): Promise<{ state: string } | null>;
}

export interface AdvanceDeps {
  db: Db;
  boss: OrchestratorBoss;
  dag: JobDag;
  run: RunRow;
  now?: Date;
  /** 覆盖节点超时（测试注入小值）。 */
  timeoutSeconds?: number;
}

export interface AdvanceSummary {
  total: number;
  terminal: number;
  succeeded: number;
  failed: number;
  skipped: number;
  enqueued: number;
  running: number;
  pending: number;
  /** 全部成员节点终态 → run 可收尾。 */
  complete: boolean;
}

/**
 * pg-boss job state → 节点态映射。null = 查不到 job 行 / 无法识别的 state。
 *
 * 已装 pg-boss v12.26.1 的 `job_state` 枚举**只有** created / retry / active / completed /
 * cancelled / failed 六个（node_modules/pg-boss/dist/plans.d.ts `JOB_STATES` + plans.js
 * `createEnumJobState`），下面六个 case 已覆盖全集。`expired` 是 v9/v10 的历史状态，v12 里
 * 超时/过期的 job 由维护扫描**删除后按 retry 或 failed 重新插入**（manager.js
 * `failJobsByTimeout*`），因此现役版本不会有节点停在 'expired' 上。
 *
 * 仍显式映射 `expired → failed`（YUK-758 review ToTaZ）：这是对**版本漂移**的零成本保险
 * ——若 pg-boss 降级/回滚到仍写 'expired' 的版本、或未来重新引入该状态，缺这一支会让节点
 * 被当作「未知」而一路挂到 NODE_TIMEOUT_SECONDS 才判失败，白等一整晚并推迟硬下游的跳过决策。
 */
export function mapBossState(
  state: string | null,
): 'succeeded' | 'failed' | 'running' | 'enqueued' | null {
  switch (state) {
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'failed';
    case 'active':
      return 'running';
    case 'created':
    case 'retry':
      return 'enqueued';
    default:
      return null;
  }
}

/**
 * 推进一条 run 一步：①轮询在飞节点终态 ②推进就绪 pending 节点（enqueue / 硬失败跳过）。
 * 幂等：只对 pending 节点做 enqueue、只对在飞节点做轮询——重复 tick 收敛到同一态。
 */
export async function advanceRun(deps: AdvanceDeps): Promise<AdvanceSummary> {
  const now = deps.now ?? new Date();
  const timeoutMs = (deps.timeoutSeconds ?? NODE_TIMEOUT_SECONDS) * 1000;

  // ── ① 轮询在飞（enqueued/running）节点的 pg-boss 终态。节点间互不依赖（步骤②另行
  //    reload 最新态，步骤①的内存改动不跨用），并行轮询省去大图每 tick 的串行往返
  //    （YUK-758 review ToTae）。
  //    **逐节点错误隔离**（review ToTa4）：裸 Promise.all 会让任一节点的瞬时故障
  //    （getJobById 抖动 / 单条 UPDATE 失败）炸掉整个 tick——handler 抛出 → pg-boss 重投递
  //    整轮，其余健康节点的推进被一并牺牲。逐个 try/catch 后本轮只丢那一个节点的观测，
  //    其余照常推进，掉队者下一 tick 自然重试（轮询本就幂等）。
  const inflight = await loadNodes(deps.db, deps.run.id);
  await Promise.all(
    [...inflight.values()].map(async (node) => {
      try {
        await pollInflightNode(deps, node, now, timeoutMs);
      } catch (err) {
        console.error(
          `[orchestrator] poll failed for node '${node.job_name}' (${node.id}) in run ${deps.run.id} — skipped this tick, will retry next tick`,
          err,
        );
      }
    }),
  );

  // ── ② 用最新态评估 pending 节点是否就绪。
  const nodes = await loadNodes(deps.db, deps.run.id);
  // 同轮齐发错峰计数（review 面板疑点 ②）：每只 job 都是独立 pg-boss 队列 + 独立 worker，
  // batchSize:1 拦不住**跨 job** 并发，故 8 个根会同秒砸向 provider。见 LAYER_STAGGER_SECONDS。
  let enqueuedThisPass = 0;
  for (const [jobName, node] of nodes) {
    if (node.status !== 'pending') continue;
    const dagNode = deps.dag.nodes.get(jobName);
    if (!dagNode) continue; // 成员集与图不一致（不应发生）——跳过防御。

    const upstreams = dagNode.deps.map((d) => ({ soft: d.soft, up: nodes.get(d.job) }));

    // 硬上游 failed/skipped → 本节点跳过（留因）。
    const blocked = upstreams.find(
      (u) => !u.soft && u.up && (u.up.status === 'failed' || u.up.status === 'skipped'),
    );
    if (blocked?.up) {
      await updateNodeStatus(deps.db, node.id, {
        status: 'skipped',
        detail: `upstream '${blocked.up.job_name}' ${blocked.up.status}`,
        now,
      });
      node.status = 'skipped';
      continue;
    }

    // 全部上游终态才可推进（否则等待）。根（无上游）此处 vacuous-true 即刻入队。
    const allTerminal = upstreams.every((u) => u.up && isTerminalNodeStatus(u.up.status));
    if (!allTerminal) continue;

    // 到此硬上游必全 succeeded（否则被 blocked 拦）。软上游若未 succeeded → stale。
    const stale = upstreams.some((u) => u.soft && u.up && u.up.status !== 'succeeded');

    // 先原子领取（CAS pending→enqueued），只有赢家 send——杜绝并发 advanceRun 重复付费入队
    //（YUK-758 review ToTaj）。领取失败 = 已被并发调用推进，跳过。
    // **意图先落库**（review ToTaI）：预生成 pg-boss job id 并随 CAS 一起写入节点行，之后
    // 才 send（带该 id）。这样不存在「job 已建但节点不知其 id」的窗口——崩溃重投递后
    // 总能靠 boss_job_id 查到真实 job 态，不会把在跑的成员误判超时 failed。
    const bossJobId = randomUUID();
    const claimed = await claimNodePending(deps.db, node.id, { bossJobId, stale, now });
    if (!claimed) continue;

    // 同轮第 n 个入队者延后 n×间隔（封顶）。第 0 个立刻发 → 串行链上零延迟。
    const startAfter = Math.min(
      enqueuedThisPass * LAYER_STAGGER_SECONDS,
      LAYER_STAGGER_MAX_SECONDS,
    );
    enqueuedThisPass += 1;
    const sentId = await deps.boss.send(
      jobName,
      stale ? { stale: true } : {},
      startAfter > 0 ? { id: bossJobId, startAfter } : { id: bossJobId },
    );
    if (!sentId) {
      // send 返回 null = INSERT 撞 ON CONFLICT DO NOTHING，即**该 id 的 job 已存在**（并非
      // 未建）。用 getJobById 判定实情后再决断，绝不把「已存在」误判成失败（YUK-758 review
      // ToTaT 的原判据在带显式 id 后不再成立）。
      const existing = await deps.boss.getJobById(jobName, bossJobId);
      if (!existing) {
        // 确实没建成 → 立即标 failed，免得挂到 NODE_TIMEOUT_SECONDS 才被发现、拖垮下游。
        await updateNodeStatus(deps.db, node.id, {
          status: 'failed',
          detail: 'boss.send returned null and no job exists for the reserved id',
          now,
        });
        node.status = 'failed';
        continue;
      }
    }
    node.status = 'enqueued';
  }

  // ── ③ 汇总（用②后 in-memory map；enqueue/skip 已就地更新 status）。
  return summarize(nodes);
}

/** 轮询单个在飞节点的 pg-boss 终态并落库（步骤① per-node，供 Promise.all 并行）。 */
async function pollInflightNode(
  deps: AdvanceDeps,
  node: NodeRow,
  now: Date,
  timeoutMs: number,
): Promise<void> {
  if (node.status !== 'enqueued' && node.status !== 'running') return;
  const jobState = node.boss_job_id
    ? mapBossState((await deps.boss.getJobById(node.job_name, node.boss_job_id))?.state ?? null)
    : null;
  if (jobState === 'succeeded') {
    await updateNodeStatus(deps.db, node.id, { status: 'succeeded', now });
  } else if (jobState === 'failed') {
    await updateNodeStatus(deps.db, node.id, {
      status: 'failed',
      detail: 'pg-boss job failed',
      now,
    });
  } else if (jobState === 'running' && node.status !== 'running') {
    await updateNodeStatus(deps.db, node.id, { status: 'running', now });
  } else if (jobState === null || jobState === 'enqueued') {
    // job 行查不到（jobState===null 且节点带 id）→ 那次 send 没落地（claim 已提交、send 前
    // 崩溃/瞬时失败）。窗内按**同一个预留 id** 补发自愈（YUK-758 review ToTaI）：pg-boss 的
    // job INSERT 是 ON CONFLICT DO NOTHING，同 id 补发幂等，最多只会存在一条真 job，绝无
    // 重复付费；窗口理由见 SEND_RECOVERY_GRACE_SECONDS。
    if (jobState === null && node.boss_job_id && withinSendRecoveryGrace(node, now)) {
      console.warn(
        `[orchestrator] node '${node.job_name}' (${node.id}) has no pg-boss job for reserved id ${node.boss_job_id} — re-sending idempotently (send never landed)`,
      );
      await deps.boss.send(node.job_name, node.stale ? { stale: true } : {}, {
        id: node.boss_job_id,
      });
      return;
    }
    // 仍在飞（created/retry/active-not-yet）或超出补发窗仍查无 → 超时兜底。
    if (isNodeTimedOut(node, now, timeoutMs)) {
      await updateNodeStatus(deps.db, node.id, {
        status: 'failed',
        detail: jobState === null ? 'pg-boss job not found (timeout)' : 'timeout',
        now,
      });
    }
  }
}

/** 节点是否仍在「send 未落地」补发宽限窗内（自 enqueued_at 起算）。 */
function withinSendRecoveryGrace(node: NodeRow, now: Date): boolean {
  if (!node.enqueued_at) return false;
  return now.getTime() - node.enqueued_at.getTime() <= SEND_RECOVERY_GRACE_SECONDS * 1000;
}

function isNodeTimedOut(node: NodeRow, now: Date, timeoutMs: number): boolean {
  if (!node.enqueued_at) return false;
  return now.getTime() - node.enqueued_at.getTime() > timeoutMs;
}

function summarize(nodes: Map<string, NodeRow>): AdvanceSummary {
  const s: AdvanceSummary = {
    total: 0,
    terminal: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    enqueued: 0,
    running: 0,
    pending: 0,
    complete: false,
  };
  for (const node of nodes.values()) {
    s.total += 1;
    switch (node.status) {
      case 'succeeded':
        s.succeeded += 1;
        s.terminal += 1;
        break;
      case 'failed':
        s.failed += 1;
        s.terminal += 1;
        break;
      case 'skipped':
        s.skipped += 1;
        s.terminal += 1;
        break;
      case 'enqueued':
        s.enqueued += 1;
        break;
      case 'running':
        s.running += 1;
        break;
      case 'pending':
        s.pending += 1;
        break;
    }
  }
  s.complete = s.total > 0 && s.terminal === s.total;
  return s;
}

export interface DriveDeps {
  db: Db;
  boss: OrchestratorBoss;
  dag: JobDag;
  now?: Date;
  timeoutSeconds?: number;
  /** DI seam：解析「今天」本地日（默认 Asia/Shanghai）。测试注入固定日。 */
  localDate?: (now: Date) => string;
}

/** 本地日（YYYY-MM-DD，默认 Asia/Shanghai）——与练习流读路径一致的时区口径。 */
export function orchestratorLocalDate(now: Date, timeZone = 'Asia/Shanghai'): string {
  // en-CA → YYYY-MM-DD。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * 锚点开闸（cron 或 manual）：收尾过期残留 run → find-or-create 今晚 run → 落节点 →
 * 推进一步 → 未完成则调度首个 tick。
 */
export async function runOrchestratorStart(
  deps: DriveDeps,
  trigger: RunTrigger,
): Promise<RunRow | null> {
  const now = deps.now ?? new Date();
  const runDate = (deps.localDate ?? orchestratorLocalDate)(now);

  // 收尾**跨日**残留 running run（上一夜 worker 挂掉遗留）——今日的不动。
  for (const stale of await listActiveRuns(deps.db)) {
    if (stale.run_date !== runDate) {
      await finishRun(deps.db, stale.id, 'abandoned', now);
    }
  }

  let run = await getActiveRunForDate(deps.db, runDate);
  if (!run) {
    // cron 重投递防重（YUK-758 review ToPUE）：cron start job 在崩溃/重投递下会二次执行；
    // 若今日已有**任意**状态的 run（含 tick 链已推到 completed 的），cron 绝不再建第二条
    // 重发全部 root（重复整晚付费任务）。manual 触发例外——显式重跑允许在完成后再建新 run。
    if (trigger === 'cron' && (await getLatestRunForDate(deps.db, runDate))) {
      return null;
    }
    // 原子建 run + 落节点（ToqXn）：杜绝 createRun 提交后崩溃留 0 节点 run。
    run = await createRunWithNodes(deps.db, {
      runDate,
      trigger,
      jobNames: [...deps.dag.nodes.keys()],
      now,
    });
    if (!run) {
      // 撞单飞（并发 start）——采纳赢家的 run。
      run = await getActiveRunForDate(deps.db, runDate);
    }
  }
  if (!run) return null;

  // 自愈补齐（ToqXn）：采纳的 run（并发赢家 / 旧部署遗留的 0 节点 run / 手工残行）可能缺节点。
  // insertNodes 幂等（onConflictDoNothing），补齐缺失后 advanceRun 才有节点可推进——否则 0 节点
  // run 的 complete 恒 false，tick 永远自转不 enqueue。
  await insertNodes(deps.db, run.id, [...deps.dag.nodes.keys()], now);

  await advanceAndContinue({ ...deps, now, run });
  return run;
}

/**
 * tick：推进今晚 active run 一步，未完成则自调度下一 tick，完成则收尾。无 active run →
 * no-op（run 已终结或尚未起步）。
 */
export async function runOrchestratorTick(deps: DriveDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const runDate = (deps.localDate ?? orchestratorLocalDate)(now);
  const run = await getActiveRunForDate(deps.db, runDate);
  if (!run) return;
  await advanceAndContinue({ ...deps, now, run });
}

/**
 * 推进一步 → 完成收尾 / 未完成调度下一 tick。
 *
 * **续链无条件保证**（YUK-758 review 面板必修 1）。tick 自调度是当夜**唯一**续跑通道，而本
 * 函数原本是「先 advance 后续链」的顺序结构：`advanceRun` 步骤② 整段（updateNodeStatus /
 * claimNodePending / boss.send / getJobById）以及 finishRun 都可能抛，一抛就**跳过续链**——
 * run 永久停在 running，当夜剩余节点（compose / question_supply / kc_dedup / dreaming /
 * knowledge_maintenance …）整片静默不跑，要等次夜锚点才 abandon。上一轮 ToTa4 的 per-node
 * try/catch 只覆盖了步骤①，治不了这条。
 *
 * 修法刻意**不是**给步骤②再套 per-node try/catch（那样仍治不了 loadNodes / finishRun 这类
 * 整段裸奔的调用）：改为在此处兜住**整个** advance+finish，异常时 log 后**照样**排下一 tick。
 * 单点推进失败于是退化成「本轮丢一拍」，下一 tick 从最新 DB 态重来（advanceRun 幂等）。
 *
 * ⚠️ 与 register.ts 的配套约束：本函数保证续链后，**tick 路径不得再 rethrow**——否则
 * pg-boss 的 2 次重投递会各自再排一条 tick，一夜留下 3 条并行链重复付费 enqueue。见 register.ts。
 */
async function advanceAndContinue(
  deps: DriveDeps & { run: RunRow },
): Promise<AdvanceSummary | null> {
  // 单一 now 贯穿 advance + finish（YUK-758 review ToTai）：避免 run.finished_at 因两次独立
  // new Date() 比末节点 finished_at 略晚的时序错位。
  const now = deps.now ?? new Date();
  let summary: AdvanceSummary | null = null;
  let settled = false;
  try {
    summary = await advanceRun({
      db: deps.db,
      boss: deps.boss,
      dag: deps.dag,
      run: deps.run,
      now,
      timeoutSeconds: deps.timeoutSeconds,
    });
    if (summary.complete) {
      await finishRun(deps.db, deps.run.id, 'completed', now);
      settled = true;
    }
  } catch (err) {
    // 吞掉是**故意**的：续链优先于本轮成功。留 loud log（FAST 队列无 DLQ，无日志即全无声）。
    console.error(
      `[orchestrator] advance failed for run ${deps.run.id} (${deps.run.run_date}) — scheduling the next tick anyway so the chain survives; state is re-read from DB next tick`,
      err,
    );
  }

  if (!settled) {
    // send 返回 null（未建 job）会静默断链、run 卡 running（YUK-758 review ToTaa）。显式检查并
    // loud log——次夜锚点是最终兜底，但断链须留观测痕迹不静默。
    const tickId = await deps.boss.send(
      ORCHESTRATOR_QUEUE,
      { tick: true },
      { startAfter: TICK_INTERVAL_SECONDS },
    );
    if (!tickId) {
      console.error(
        `[orchestrator] next tick send returned null for run ${deps.run.id} (${deps.run.run_date}) — tick chain broken; run stays 'running' until next anchor abandons it`,
      );
    }
  }
  return summary;
}
