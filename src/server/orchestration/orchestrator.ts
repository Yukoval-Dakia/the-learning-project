// YUK-758 — 夜间任务编排 orchestrator 驱动核心。
//
// 单锚点 cron 开闸 → 建「今晚运行记录」+ enqueue 根节点；每 tick 轮询节点终态、推进
// 就绪下游、跳过硬上游失败者，未完成则自调度下一 tick。执行仍走既有 pg-boss handler
// （orchestrator 只 boss.send 触发 + 轮询 boss.getJobById），业务代码零改动。
//
// 逐边失败语义：硬边（默认）——上游 failed/skipped → 下游 skipped（留 detail 痕迹）；
// 软边——上游未 succeeded 但硬上游齐 → 下游照跑，并在**节点行**上记 stale=true。
//
// YUK-778：软边的 stale 曾**同时**作为 job payload `{ stale: true }` 发给成员 handler。
// 那条 payload 没有任何 handler 读（两条软边的下游 knowledge_maintenance_nightly /
// dreaming_nightly 都不碰 job.data），而它的存在暗示「下游会因上游陈旧而调整行为」——
// 一个不成立的承诺。按「无消费者不留标记」删除 payload；软边语义（下游照跑）不变，
// stale 事实继续记在节点行上，并由本文件的收尾/放弃日志读出（summarize → describeNodeCensus）
// ——那一列因此有当下就成立的读者，而不是把同一个「建成不通电」从 payload 挪到列上。

import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import { readJobYieldReport } from '@/server/boss/job-yield';
import {
  LAYER_STAGGER_MAX_SECONDS,
  LAYER_STAGGER_SECONDS,
  NODE_TIMEOUT_SECONDS,
  ORCHESTRATOR_ANCHOR_HOUR,
  ORCHESTRATOR_ANCHOR_MINUTE,
  ORCHESTRATOR_CATCHUP_WINDOW_SECONDS,
  ORCHESTRATOR_QUEUE,
  ORCHESTRATOR_TZ,
  TICK_INTERVAL_SECONDS,
} from './constants';
import {
  type NodeRow,
  type RunRow,
  type RunTrigger,
  claimNodePending,
  createRunWithNodes,
  finishRun,
  getActiveRunById,
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
  /**
   * `output` 是 pg-boss 存下的 handler resolved value（batchSize:1 时即 handler 返回值，
   * manager.js `complete(name, jobIds, jobIds.length === 1 ? result : undefined)`）。
   * YUK-779 起夜链 handler 用它回传 {@link readJobYieldReport} 可解的产出报告；可选，
   * 旧 handler / 非夜链 job 不带它照常工作。
   */
  getJobById(name: string, id: string): Promise<{ state: string; output?: unknown } | null>;
  /**
   * 取消一条已发出的成员 job（YUK-781 B）。语义以**实装** pg-boss v12.26.1 为准
   * （node_modules/pg-boss/dist/plans.js `cancelJobs`）：
   *
   *   UPDATE job SET completed_on = now(), state = 'cancelled'
   *   WHERE name = $1 AND id = ANY($2) AND state < 'completed'
   *
   * `job_state` 是**有序** enum（plans.js `createEnumJobState` 注释「ENUM definition order is
   * important」，序为 created < retry < active < completed < cancelled < failed），故
   * `state < 'completed'` 恰好覆盖 created / retry / active 三态。
   *
   * ⚠️ **对 active job 只切断未来、不中断当下**：DB 行被置 cancelled，但**已被 worker 领走、
   * 正在执行的 handler 不会被打断**，其业务写入仍会落地。它跑完时的 `complete`/`fail` 因
   * `WHERE j.state = 'active'` 守卫而变成 0 行 no-op，job 稳定停在 cancelled、不会重试。
   * 残留风险因此是「已 active 的那一只本轮仍会写一次数据」，取消能兜住的是
   * created/retry（含重试预算里的后续尝试）——即绝大多数残留量与全部重复付费尝试。
   *
   * 幂等 / 安全：不存在的 id 只是 0 行（`mapCommandResponse` 返回 affected:0，不抛）；已终态的
   * job 不受影响（`state < 'completed'` 排除 completed/cancelled/failed）。
   */
  cancel(name: string, id: string): Promise<void>;
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
  /**
   * 本 run 里带 stale 标记（软上游未成功仍被放行）的节点数（YUK-778）。
   *
   * 这是 `dag_orchestration_node.stale` 的**活消费者**。删掉那条无人读的
   * `{ stale: true }` job payload 之后，若这一列也没人读，它就只是把同一个「建成不通电」
   * 从 payload 挪到列上。收尾日志打出这个计数，让「dreaming 昨晚产出为什么怪」能从一行
   * 日志回答（两张调度态表是 BACKUP_EXCLUDED 的，日志是唯一出口）。
   */
  stale: number;
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
 * 把一个节点落到终态**并留下一行日志**（YUK-778 —— 调度控制面唯一的诊断出口）。
 *
 * 为什么是一个 choke point 而不是在九个调用点各写一句 console：`dag_orchestration_run/_node`
 * 两张表都在 `BACKUP_EXCLUDED` 里（export/constants.ts），出了事只有进程日志可查；而在此之前
 * skip / fail 两类终态**一行日志都不打**——「昨晚 dreaming 为什么没跑」只能靠人肉连进生产库
 * 翻调度表。散写九句的问题不是啰嗦，是下一个终态分支会**默默**不打日志，缺口静悄悄回来
 * ——本文件当前已有九个落终态的分支，它们全部来自 YUK-758 之后的 review 修补，还会再加。
 * 收在这一个函数里，新终态分支自动带日志。
 *
 * **只在 CAS 真的写动了那一行时才打**：`updateNodeStatus` 的守卫排除已终态节点，陈旧/并发
 * 调用影响 0 行却照样 resolve。无条件打日志会报出从未发生的转移（例如把一个已 succeeded
 * 的节点报成 failed），那比不打更坏——诊断出口一旦会说谎就不能用了。
 *
 * 分级：failed → error（有东西坏了）；skipped → warn（多数是硬上游失败的**连坐**，是设计
 * 内的降级路径，不该和真故障同级喊）；succeeded → 不打（一夜 14 个成员全打就是噪声，且
 * 「成功但空跑」YUK-779 已在 handler 侧 loud log 过一次，收尾行还会给总账）。
 */
async function settleNode(
  db: Db,
  run: RunRow,
  node: NodeRow,
  input: { status: 'succeeded' | 'failed' | 'skipped'; detail?: string | null; now: Date },
): Promise<boolean> {
  const applied = await updateNodeStatus(db, node.id, input);
  if (!applied) return false;
  node.status = input.status;
  if (input.status === 'succeeded') return true;
  const line = `[orchestrator] node '${node.job_name}' ${input.status} in run ${run.id} (${run.run_date})${
    input.detail ? `: ${input.detail}` : ''
  }`;
  if (input.status === 'failed') console.error(line);
  else console.warn(line);
  return true;
}

/** run 级日志的节点总账一行（YUK-778）。 */
function describeNodeCensus(s: AdvanceSummary): string {
  return `${s.succeeded}/${s.total} succeeded, ${s.failed} failed, ${s.skipped} skipped, ${
    s.enqueued + s.running
  } still in flight, ${s.pending} never started, ${s.stale} ran with a non-succeeded soft upstream`;
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
    // 逐节点错误隔离，与步骤①同一韧性模型（YUK-758 review ToTbw）：单节点的 claim / send /
    // updateNodeStatus 抖动不该让**本轮**其余就绪节点全部停摆。注意这与 advanceAndContinue 的
    // 续链保证是**两层**：那层保证「下一拍一定会来」，这层保证「本拍其余节点照推」。
    try {
      if (await advancePendingNode(deps, jobName, node, nodes, now, enqueuedThisPass)) {
        enqueuedThisPass += 1;
      }
    } catch (err) {
      console.error(
        `[orchestrator] enqueue failed for node '${node.job_name}' (${node.id}) in run ${deps.run.id} — skipped this tick, will retry next tick`,
        err,
      );
    }
  }

  // ── ③ 汇总（用②后 in-memory map；enqueue/skip 已就地更新 status）。
  return summarize(nodes);
}

/**
 * 推进单个 pending 节点（步骤② per-node）。返回 true 表示本次真的入队了一个 job
 * （供调用方推进同轮错峰序号）；skip / 等待上游 / 领取失败均返回 false。
 */
async function advancePendingNode(
  deps: AdvanceDeps,
  jobName: string,
  node: NodeRow,
  nodes: Map<string, NodeRow>,
  now: Date,
  staggerIndex: number,
): Promise<boolean> {
  {
    const dagNode = deps.dag.nodes.get(jobName);
    if (!dagNode) {
      // 该节点在**当前** manifest 里已不是图成员（夜跑进行中升级/回滚，成员被删或改名）。
      // 原实现 `continue` 跳过它——但 summarize() 仍把它计入 total，于是 terminal 永远凑不齐、
      // run 永不 completed、依赖它的分支永不推进，tick 每分钟空转到次夜被 abandon
      //（YUK-758 review ToTjN）。收敛为终态 skipped 并留因：让本夜图按「少了这个成员」正常收尾，
      // 其硬下游据 skipped 语义跳过（与上游失败同一处理），运维也能从 detail 看出真因。
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: 'job is no longer a DAG member in the running build (manifest changed mid-run)',
        now,
      });
      return false;
    }

    const upstreams = dagNode.deps.map((d) => ({ soft: d.soft, job: d.job, up: nodes.get(d.job) }));

    // 防御：硬上游是当前图成员但本 run 查不到它的节点行。正常路径下 tick/start 的 insertNodes
    // 补齐已消灭这种态（ToTk1N），此处是**最后一道**——若它仍发生，`allTerminal` 会因
    // `u.up &&` 恒 false 让本节点永久 pending、run 卡 running 空转（ToTvT）。按 skipped 语义
    // 收敛并留因，绝不留下无法收敛的 run。
    const missingHard = upstreams.find((u) => !u.soft && !u.up);
    if (missingHard) {
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: `upstream '${missingHard.job}' has no node row in this run`,
        now,
      });
      return false;
    }

    // 硬上游 failed/skipped → 本节点跳过（留因）。
    const blocked = upstreams.find(
      (u) => !u.soft && u.up && (u.up.status === 'failed' || u.up.status === 'skipped'),
    );
    if (blocked?.up) {
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: `upstream '${blocked.up.job_name}' ${blocked.up.status}`,
        now,
      });
      return false;
    }

    // 全部上游终态才可推进（否则等待）。根（无上游）此处 vacuous-true 即刻入队。
    // **软**上游缺节点行时视作「已终态但未成功」——不阻塞推进（软边的本意就是上游不成功也照跑），
    // 否则同样会把本节点钉死在 pending 上（ToTvT 的软边侧）。硬上游缺行已在上面收敛为 skipped。
    const allTerminal = upstreams.every((u) => (u.up ? isTerminalNodeStatus(u.up.status) : u.soft));
    if (!allTerminal) return false;

    // 到此硬上游必全 succeeded（否则被 blocked 拦）。软上游未 succeeded（含缺行）→ stale。
    // 这个事实只落**节点行**，不进 job payload（YUK-778，理由见文件头）。
    const stale = upstreams.some((u) => u.soft && (!u.up || u.up.status !== 'succeeded'));

    // 先原子领取（CAS pending→enqueued），只有赢家 send——杜绝并发 advanceRun 重复付费入队
    //（YUK-758 review ToTaj）。领取失败 = 已被并发调用推进，跳过。
    // **意图先落库**（review ToTaI）：预生成 pg-boss job id 并随 CAS 一起写入节点行，之后
    // 才 send（带该 id）。这样不存在「job 已建但节点不知其 id」的窗口——崩溃重投递后
    // 总能靠 boss_job_id 查到真实 job 态，不会把在跑的成员误判超时 failed。
    const bossJobId = randomUUID();
    const claimed = await claimNodePending(deps.db, node.id, { bossJobId, stale, now });
    if (!claimed) return false;
    // 内存行跟上刚落库的 stale（YUK-778）。本轮 summarize 读的是这张内存 map，不同步就会
    // 少算本轮新入队的 stale 节点。
    //
    // **这不是防御性的**（独立评审 NIT）：初稿注释以为「刚入队的节点非终态 ⇒ 本轮 complete
    // 必为 false ⇒ 收尾日志打不到这个漏算」，那条推理有洞——紧接着的 send-returns-null 分支
    // （见下方 `if (!sentId)`）会把**刚领取的这个节点**在同一轮里落成 failed。若它恰是最后
    // 一个非终态节点，本轮 complete 就是 true，收尾总账带着漏算的 stale 计数打出去。
    // 故此处的同步是真在修一条可达路径，不是洁癖。
    node.stale = stale;

    // 同轮第 n 个入队者延后 n×间隔（封顶）。第 0 个立刻发 → 串行链上零延迟。
    const startAfter = Math.min(staggerIndex * LAYER_STAGGER_SECONDS, LAYER_STAGGER_MAX_SECONDS);
    // payload 恒空（YUK-778）：成员 handler 一律不读 job.data，从前那条 `{ stale: true }`
    // 没有任何消费者。留着它会让 manifest 的软边注释「下游带 stale 照跑」读起来像是下游
    // **知道**自己在陈旧输入上跑——它不知道。空 payload 如实表达「触发即执行」。
    const sentId = await deps.boss.send(
      jobName,
      {},
      startAfter > 0 ? { id: bossJobId, startAfter } : { id: bossJobId },
    );
    if (!sentId) {
      // send 返回 null = INSERT 撞 ON CONFLICT DO NOTHING，即**该 id 的 job 已存在**（并非
      // 未建）。用 getJobById 判定实情后再决断，绝不把「已存在」误判成失败（YUK-758 review
      // ToTaT 的原判据在带显式 id 后不再成立）。
      const existing = await deps.boss.getJobById(jobName, bossJobId);
      if (!existing) {
        // 确实没建成 → 立即标 failed，免得挂到 NODE_TIMEOUT_SECONDS 才被发现、拖垮下游。
        await settleNode(deps.db, deps.run, node, {
          status: 'failed',
          detail: 'boss.send returned null and no job exists for the reserved id',
          now,
        });
        return false;
      }
    }
    node.status = 'enqueued';
    return true;
  }
}

/** 轮询单个在飞节点的 pg-boss 终态并落库（步骤① per-node，供 Promise.all 并行）。 */
async function pollInflightNode(
  deps: AdvanceDeps,
  node: NodeRow,
  now: Date,
  timeoutMs: number,
): Promise<void> {
  if (node.status !== 'enqueued' && node.status !== 'running') return;
  const job = node.boss_job_id ? await deps.boss.getJobById(node.job_name, node.boss_job_id) : null;
  const jobState = mapBossState(job?.state ?? null);
  if (jobState === 'succeeded') {
    // YUK-779 — 一个 handler 可以「成功」而**产出为零**：它对 AI 失败的 per-cell /
    // per-row 吞错在限流风暴下把整批都吞了，job 照常 resolve，节点照常转绿，硬下游
    // 在空数据上继续跑，而运维看到的是「昨晚一切正常」。handler 把产出报告作为返回值
    // 交给 pg-boss（存进 job.output），这里读回来盖进节点 detail —— 正面修复那个假象。
    //
    // 只**盖 detail**，不改 status：节点仍是 succeeded、硬下游仍照跑。「异常空跑要不要
    // 直接判 failed（进而让硬下游 skip）」是产品语义决策，见 job-yield.ts 文件末。
    await settleNode(deps.db, deps.run, node, {
      status: 'succeeded',
      detail: readJobYieldReport(job?.output)?.detail ?? undefined,
      now,
    });
  } else if (jobState === 'failed') {
    await settleNode(deps.db, deps.run, node, {
      status: 'failed',
      detail: 'pg-boss job failed',
      now,
    });
  } else if (jobState === 'running' && node.status !== 'running') {
    await updateNodeStatus(deps.db, node.id, { status: 'running', now });
  } else if (jobState === null || jobState === 'enqueued') {
    // job 行查不到（jobState===null 且节点带 id）→ 那次 send 没落地（claim 已提交、send 前
    // 崩溃/瞬时失败）。按**同一个预留 id** 补发自愈（YUK-758 review ToTaI）：pg-boss 的
    // job INSERT 是 ON CONFLICT DO NOTHING，同 id 补发幂等，最多只会存在一条真 job，绝无
    // 重复付费。
    //
    // 补发窗 = 「尚未超时」（ToTk1L）。初版另设了 5min 窗，是拿「崩溃瞬间是毫秒级」推的——推错了
    // 对象：要覆盖的是**从崩溃到下一 tick 真正观测到该节点**的间隔，含停机/重启/重投递延迟，
    // 轻易超过 5min，于是一个**确定从未存在过**的 job 被拒绝补发、空等到超时被误判 failed，硬
    // 下游连坐。既然补发同 id 幂等，只要还没判超时就值得补，独立窗口纯属多余，故并入超时判据。
    // （「跑完被 retention 清掉 → 补发变重跑」不成立：队列 retention 默认 7d ≫ 节点超时 7h。）
    if (jobState === null && node.boss_job_id && !isNodeTimedOut(node, now, timeoutMs)) {
      console.warn(
        `[orchestrator] node '${node.job_name}' (${node.id}) has no pg-boss job for reserved id ${node.boss_job_id} — re-sending idempotently (send never landed)`,
      );
      // payload 恒空，与首次 send 一致（YUK-778）——补发必须与原发同形，否则「同 id 幂等
      // 补发」这条不变量在语义上就不成立了。
      await deps.boss.send(node.job_name, {}, { id: node.boss_job_id });
      return;
    }
    // 仍在飞（created/retry/active-not-yet）或超出补发窗仍查无 → 超时兜底。
    if (isNodeTimedOut(node, now, timeoutMs)) {
      // **先取消再判死**（YUK-781 B 同族）：判 failed 会让硬下游按「上游失败」跳过，但那只
      // job 在 pg-boss 侧仍是 created/retry/active，之后照样执行并写业务数据——图上说"没跑"、
      // 实际跑了，且还会烧掉剩余重试预算。jobState===null 时确认无 job 行，无需多一次往返。
      if (jobState !== null && node.boss_job_id) {
        await cancelBossJob(
          deps.boss,
          node.job_name,
          node.boss_job_id,
          `node timed out in run ${deps.run.id}`,
        );
      }
      await settleNode(deps.db, deps.run, node, {
        status: 'failed',
        detail: jobState === null ? 'pg-boss job not found (timeout)' : 'timeout',
        now,
      });
    }
  }
}

/**
 * 尽力取消一条成员 job（YUK-781 B）。失败只 loud log 不抛——取消是「止损」，绝不能反过来
 * 挡住调用方本要做的事（判超时 / 收尾 abandon 让新一夜起步）。返回是否取消成功。
 */
async function cancelBossJob(
  boss: OrchestratorBoss,
  jobName: string,
  bossJobId: string,
  context: string,
): Promise<boolean> {
  try {
    await boss.cancel(jobName, bossJobId);
    return true;
  } catch (err) {
    console.error(
      `[orchestrator] failed to cancel pg-boss job ${bossJobId} for member '${jobName}' (${context}) — it may still execute and write data`,
      err,
    );
    return false;
  }
}

/**
 * 收尾一条 run 时，取消它所有**非终态**节点的在飞 pg-boss job（YUK-781 B）。
 * 调用点在 `finishRun(..., 'abandoned')` **之后**——顺序理由见那里的 TOCTOU 注释。
 *
 * 不做会怎样：`runOrchestratorStart` 收尾跨日残留 run 时只 `finishRun` 标 abandoned，节点对应的
 * created/retry/active job **原封不动**。于是
 *  · 旧 job 照常执行并写业务数据，而调度记录上这一夜已被判"放弃"；
 *  · 新建的今日 run 会再发一遍同名成员 → 重复付费；
 *  · 旧 job 不受**新图**上游约束（它是上一夜的图排出来的），等于绕过 DAG 依赖门跑。
 *
 * 顺带把节点行收敛到终态：run 已 abandoned 就不会再有 tick 碰它，留一堆永久 `enqueued` 节点
 * 只会让观测面读出幽灵「在跑」。
 *
 * **终态选取**：节点状态枚举里没有 `cancelled`（加一个要动 schema + CHECK，越界），故在
 * `failed` / `skipped` 之间按事实二选一 ——
 *  · 已派发过 job（有 `boss_job_id`）→ `failed`：它确实被派出去且没有成功；
 *  · 从未入队（仍 pending）→ `skipped`：它压根没跑过，记成 failed 会让读面（YUK-774）的
 *    失败计数虚高，把「今夜被整体放弃」误读成「这么多成员跑挂了」。
 * 真因一律进 detail，两类都可从痕迹还原。
 *
 * **契约：本函数不抛**（PR #1075 OCR major）。逐节点 try/catch 只挡住"某个节点"的失败；
 * `loadNodes` 这类**逐节点之外**的失败会一路穿出 `runOrchestratorStart`，于是
 *  · 这条残留 run 的 `finishRun(..., 'abandoned')` 被跳过（它排在本函数之后）；
 *  · **今夜的 run 根本建不起来** —— 一次瞬时 DB 抖动把「止损」升级成「整夜不跑」，
 *    正好与本票要修的东西同形。
 * 止损绝不能比它要防的损失更贵，故整个函数体兜住、loud log 后返回，让 abandon 照常进行。
 * 与 `cancelBossJob` 的 never-throw 策略同一条线。
 */
async function cancelRunInflightJobs(
  deps: { db: Db; boss: OrchestratorBoss },
  run: RunRow,
  now: Date,
  /**
   * 本次调用是否**赢下了**那条 run 的 abandon CAS（YUK-778 独立评审 MINOR）。只影响是否打
   * 总账日志，不影响清扫本身——清扫是尽力止损，输掉 CAS 也照做（幂等，且已终态节点被跳过）。
   *
   * 为什么必须分开：输掉 CAS 意味着**别人**收尾了这条 run，而对手可能是 `completed`。此时
   * 无条件打「abandoned run X left …」就会在 error 级报告一次没发生的放弃——正是本 PR 的
   * 日志设计要杜绝的那类谎话。上面那行 ABANDONING 已经这么闸了，总账不跟上就是半道闸。
   */
  announce: boolean,
): Promise<void> {
  let nodes: Map<string, NodeRow>;
  try {
    nodes = await loadNodes(deps.db, run.id);
  } catch (err) {
    console.error(
      `[orchestrator] failed to load nodes of run ${run.id} (${run.run_date}) while abandoning — its in-flight jobs are NOT cancelled and may still execute; abandoning anyway so tonight can start`,
      err,
    );
    return;
  }
  // 放弃前的节点总账（YUK-778）。这一行**就是**「昨晚为什么没跑完」的答案：它是被放弃的
  // 那一夜留下的唯一快照——下面的清扫会把每个非终态节点改写成 failed/skipped，事后再查
  // 调度表已看不出「当时卡在哪一层」。两张表又 BACKUP_EXCLUDED，日志是唯一出口。
  if (announce) {
    console.error(
      `[orchestrator] abandoned run ${run.id} (${run.run_date}) left ${describeNodeCensus(
        summarize(nodes),
      )} — settling its non-terminal nodes and cancelling their pg-boss jobs`,
    );
  }
  for (const node of nodes.values()) {
    if (isTerminalNodeStatus(node.status)) continue;
    try {
      if (!node.boss_job_id) {
        await settleNode(deps.db, run, node, {
          status: 'skipped',
          detail: 'run abandoned before this node was enqueued',
          now,
        });
        continue;
      }
      const cancelled = await cancelBossJob(
        deps.boss,
        node.job_name,
        node.boss_job_id,
        `run ${run.id} (${run.run_date}) abandoned`,
      );
      await settleNode(deps.db, run, node, {
        status: 'failed',
        detail: cancelled
          ? 'run abandoned; pg-boss job cancelled'
          : 'run abandoned; pg-boss job cancel failed (job may still execute)',
        now,
      });
    } catch (err) {
      console.error(
        `[orchestrator] failed to settle node '${node.job_name}' (${node.id}) while abandoning run ${run.id}`,
        err,
      );
    }
  }
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
    stale: 0,
    complete: false,
  };
  for (const node of nodes.values()) {
    s.total += 1;
    if (node.stale) s.stale += 1;
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
  // 除了标 abandoned，还要取消其在飞 job（YUK-781 B）：只改调度记录不动 job，旧 job 仍会执行、
  // 写数据、与今日新 run 的同名成员重复付费，且绕过新图的依赖门。见 cancelRunInflightJobs。
  //
  // **顺序：先 finishRun 再取消**（PR #1075 OCR minor 的 TOCTOU）。反过来会开一个与取消扫描
  // **等长**的窗口：扫描期间 run 仍是 running，旧 run 那条仍留在 pg-boss 里的 tick 链若此刻被
  // 消费，`advanceRun` 可以 claim 并 send 出**新的**成员 job；它诞生在我们的 `loadNodes` 快照
  // 之后，于是不会被取消，照跑照写——正是本条要堵的东西。`finishRun` 是 CAS(status='running')，
  // 先落它之后任何 tick 的 `getActiveRunById`/`getActiveRunForDate` 都查不到该 run，新的推进
  // 无法**开始**；窗口从「整轮扫描」缩到「一次已在飞的 advance」。
  // 残留（不可消除、已知并接受）：恰好卡在 claim→send 之间的那一次 advance 仍可能漏出一只 job。
  // 另一侧的取舍：先 finishRun 意味着扫描中途崩溃会留下「已 abandoned 但未取消」的 job——但那
  // 恰好等于本 PR 之前的行为，是严格改善而非回退；而 TOCTOU 是持续存在的洞。
  for (const leftover of await listActiveRuns(deps.db)) {
    if (leftover.run_date !== runDate) {
      // 只在 CAS 真赢时才喊（YUK-778）：finishRun 的 where 带 status='running'，并发的
      // 收尾者会影响 0 行却照样 resolve，无条件打日志等于报出一次没发生的放弃。
      const abandoned = await finishRun(deps.db, leftover.id, 'abandoned', now);
      if (abandoned) {
        console.error(
          `[orchestrator] ABANDONING run ${leftover.id} (${leftover.run_date}) — it was still 'running' when the ${runDate} anchor fired, i.e. that night never reached a terminal state`,
        );
      }
      // 清扫无条件跑（止损），但总账日志跟着同一个 CAS 结果走——见 cancelRunInflightJobs 的
      // `announce` 参数：输掉 CAS 时对手可能是 `completed`，那时喊「abandoned」就是假消息。
      await cancelRunInflightJobs(deps, leftover, now, abandoned);
    }
  }

  let run = await getActiveRunForDate(deps.db, runDate);
  if (!run) {
    // cron 重投递防重（YUK-758 review ToPUE）：cron start job 在崩溃/重投递下会二次执行；
    // 若今日已有**任意**状态的 run（含 tick 链已推到 completed 的），cron 绝不再建第二条
    // 重发全部 root（重复整晚付费任务）。manual 触发例外——显式重跑允许在完成后再建新 run。
    const guarded = trigger === 'cron' ? await getLatestRunForDate(deps.db, runDate) : null;
    if (guarded) {
      // 这条 return 是**「今夜整链不跑」的第四种成因**，且在本票之前同样一行日志不打
      //（YUK-778 独立评审 MAJOR）。防重本身是对的（cron 重投递不该重发整晚付费任务），但它
      // 也会在一个不该沉默的场景上触发：`src/server/export/constants.ts:312-316` 自述，
      // 备份还原后残留的 `completed` run 会让本闸「skip that calendar day's chain entirely…
      // silent」。运维看到的又是「昨晚什么都没发生」——与本票要修的那个不可区分性同形。
      // 隔壁 runOrchestratorCatchUp 的同类跳过早就打日志了，这里补齐。
      console.warn(
        `[orchestrator] cron anchor for ${runDate} did NOT start a chain: run ${guarded.id} already exists for this date (${guarded.status}). This is the redeliver guard; if you did not expect a run today, check for a leftover row (e.g. an archive restore) — the guard cannot tell one from a genuine earlier start`,
      );
      return null;
    }
    // 原子建 run + 落节点（ToqXn）：杜绝 createRun 提交后崩溃留 0 节点 run。
    run = await createRunWithNodes(deps.db, {
      runDate,
      trigger,
      jobNames: [...deps.dag.nodes.keys()],
      now,
    });
    if (run) {
      // 唯一一行「今晚确实开闸了」的证据（YUK-778）。在此之前一次**成功**的夜跑从头到尾
      // 不打任何日志——于是「昨晚跑了吗」和「昨晚 worker 根本没起来」在日志里长得一模一样。
      // 只在**真建成**时打（撞单飞的败者走下面的 adopt 分支，它没开闸，不该也喊一声）。
      console.log(
        `[orchestrator] run ${run.id} started for ${runDate} (trigger=${trigger}, ${deps.dag.nodes.size} member(s), ${deps.dag.roots.length} root(s))`,
      );
    } else {
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
export async function runOrchestratorTick(deps: DriveDeps, runId?: string): Promise<void> {
  const now = deps.now ?? new Date();
  // 优先按 tick 自带的 run_id 定位（YUK-758 review ToTvLt）：按「当前本地日」反查会让**跨本地
  // 午夜**的 run 在换日后失联——手工整链重跑可以在 23:5x 起步，00:00 后的第一拍按新日期查不到
  // 它、直接 return，剩余节点全部停摆到 02:30 锚点把它 abandon。带 id 的 tick 永远找得到自己。
  // 无 id 的 tick（旧版本残留在队列里的）回退按日期查，保持升级期兼容。
  const run = runId
    ? await getActiveRunById(deps.db, runId)
    : await getActiveRunForDate(deps.db, (deps.localDate ?? orchestratorLocalDate)(now));
  if (!run) return;

  // 热升级新增成员的补齐（YUK-758 review ToTk1N / ToTvT）：start 路径已有这句自愈，tick 路径
  // 原本没有。缺它时，「夜跑进行中部署新 manifest 新增成员 x，且已有成员 y 依赖 x」会让 y 的
  // 上游解析恒为 undefined → allTerminal 恒 false → y **永久 pending** → terminal 永远凑不齐 →
  // run 卡 running 空转到次夜。这是 ToTjN（成员被删）的**对称缺口**（成员被加）。
  // insertNodes 幂等（onConflictDoNothing），补齐后新成员当夜即按依赖正常参与。
  await insertNodes(deps.db, run.id, [...deps.dag.nodes.keys()], now);

  await advanceAndContinue({ ...deps, now, run });
}

/** 本地时刻的「当日第几分钟」（默认 Asia/Shanghai，该时区无 DST，无需处理跳变）。 */
export function orchestratorLocalMinuteOfDay(now: Date, timeZone = ORCHESTRATOR_TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: 'hour' | 'minute') =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return value('hour') * 60 + value('minute');
}

/**
 * 距**最近一次**锚点过去了多少分钟（0–1439）。
 *
 * `mod 1440` 不是装饰（PR #1075 OCR minor）：裸减法只在「锚点靠前、窗口不跨午夜」时成立。
 * 若锚点被挪到傍晚/深夜（如 23:00），00:30 会算出 `30 - 1380 = -1350` 而被判超窗——补跑对
 * 任何跨午夜锚点**永久失效**，且是静默的。取模后它等于 90，与「窗口是**已过时长**区间
 * `[0, window)`」的文档语义一致。锚点在前的情形也仍正确：02:00（锚点 02:30 之前 30min）
 * 取模后是 1410，远超 5h 窗 → 照旧不补，等今夜的锚点。
 *
 * 前提由 `isWithinCatchUpWindow` 强制，见那里。
 */
export const MINUTES_PER_DAY = 24 * 60;

export function minutesSinceAnchor(
  now: Date,
  anchorMinuteOfDay = ORCHESTRATOR_ANCHOR_HOUR * 60 + ORCHESTRATOR_ANCHOR_MINUTE,
  timeZone = ORCHESTRATOR_TZ,
): number {
  return (
    (orchestratorLocalMinuteOfDay(now, timeZone) - anchorMinuteOfDay + MINUTES_PER_DAY) %
    MINUTES_PER_DAY
  );
}

/**
 * 补跑窗口判据。**只会 fail-closed**（PR #1075 OCR major + minor）。
 *
 * 这道闸唯一的职责是「拦住不该补的时刻」，所以它算不出答案时必须**拒补**，绝不能放行——
 * 而朴素写法恰恰相反地 fail-**open**：
 *  · `orchestratorLocalMinuteOfDay` 在 Intl 拿不到 hour/minute 时返回 `NaN`（非法 tz 字串、
 *    非法 Date 输入）。`NaN >= windowMinutes` 是 `false`，于是「超窗」判定不成立 → **照补**，
 *    整条付费夜链可以在任意时刻开跑。这正是本窗口存在的意义的反面。
 *  · `windowMinutes >= 1440` 时，mod-1440 的 `elapsed` 恒 `< windowMinutes`，「锚点之前」与
 *    「锚点之后」不再可分 → 窗口形同虚设，任何时刻都补。文档写了前提但没人强制。
 *
 * 两者都改成**抛**：`runOrchestratorCatchUp` 的既有 try/catch 把它转成
 * `{ skipped, reason:'error' }` + loud log，即"算不出就不补"，与 fail-closed 一致。
 */
export function isWithinCatchUpWindow(elapsedMinutes: number, windowMinutes: number): boolean {
  if (!Number.isFinite(elapsedMinutes)) {
    throw new Error(
      `[orchestrator] cannot evaluate the catch-up window: minutes-since-anchor is ${elapsedMinutes} (unreadable local clock)`,
    );
  }
  if (!(windowMinutes > 0 && windowMinutes < MINUTES_PER_DAY)) {
    throw new Error(
      `[orchestrator] cannot evaluate the catch-up window: ORCHESTRATOR_CATCHUP_WINDOW_SECONDS yields ${windowMinutes}min, which must be >0 and <${MINUTES_PER_DAY} (a whole-day window makes "before" and "after" the anchor indistinguishable)`,
    );
  }
  return elapsedMinutes < windowMinutes;
}

/** 补跑决策结果——测试据此断言"补了/没补及为什么"，不必去刮日志。 */
export type CatchUpOutcome =
  | { action: 'started'; run: RunRow }
  | { action: 'skipped'; reason: 'outside-window' | 'run-exists' | 'error' };

/**
 * 启动期错过锚点的幂等补跑（YUK-781 A）。worker 挂载完成后调一次。
 *
 * 判据两道，缺一不可：
 *  ① **窗口**：本地时间须落在 `[锚点, 锚点 + ORCHESTRATOR_CATCHUP_WINDOW_SECONDS)` 内。
 *     没有这道闸，中午/傍晚的任何一次重启都会把整条夜链（8 个付费 LLM 根 + 下游）拉到白天跑。
 *     超窗只 loud log 留痕、等次夜锚点。
 *  ② **当日无 run**：用 `getLatestRunForDate`（**任意**状态，含 completed/abandoned）而非
 *     「无 active run」。两个理由：已 completed 的当日 run 不该被重跑；已有 running run 时
 *     若走 `runOrchestratorStart` 会 adopt 它并再排一条 tick 链 —— 与 pg-boss 里既有的那条
 *     并行自转，白烧。`runOrchestratorStart` 内部对 cron 触发另有一道同样的闸，那是并发
 *     backstop（两副本同秒过闸）；这里这道是「不 adopt」闸，两者语义不同、都要留。
 *
 * **契约：本函数不抛。** 补跑是启动期的尽力止损，绝不能挡 worker boot（照 start-worker.ts
 * 里 reconcileStuckAiTaskRuns 的先例）。调用方仍应再包一层 try/catch 作为带式加背带。
 *
 * 多副本并发：两个 worker 同秒 boot 会同时过①②，靠 `createRunWithNodes` 的
 * partial unique(run_date) where status='running' 单飞——败者 `onConflictDoNothing` 返回 null
 * 后 adopt 赢家的 run；成员 job 另有 `claimNodePending` 的 CAS 领取，故根节点也只发一次。
 */
export async function runOrchestratorCatchUp(deps: DriveDeps): Promise<CatchUpOutcome> {
  try {
    const now = deps.now ?? new Date();
    const elapsed = minutesSinceAnchor(now);
    const windowMinutes = ORCHESTRATOR_CATCHUP_WINDOW_SECONDS / 60;
    // fail-closed：算不出窗口就当作"不补"（抛 → 下面的 catch → skipped/error + loud log）。
    if (!isWithinCatchUpWindow(elapsed, windowMinutes)) {
      console.log(
        `[orchestrator] boot catch-up skipped: ${elapsed}min since the last ${ORCHESTRATOR_ANCHOR_HOUR}:${String(ORCHESTRATOR_ANCHOR_MINUTE).padStart(2, '0')} ${ORCHESTRATOR_TZ} anchor, outside the ${windowMinutes}min window`,
      );
      return { action: 'skipped', reason: 'outside-window' };
    }
    const runDate = (deps.localDate ?? orchestratorLocalDate)(now);
    const existing = await getLatestRunForDate(deps.db, runDate);
    if (existing) {
      console.log(
        `[orchestrator] boot catch-up skipped: run ${existing.id} already exists for ${runDate} (${existing.status})`,
      );
      return { action: 'skipped', reason: 'run-exists' };
    }
    console.warn(
      `[orchestrator] boot catch-up: no run for ${runDate} and we are ${elapsed}min past the anchor — the anchor cron was missed (pg-boss does not replay missed crons); starting tonight's run now`,
    );
    const run = await runOrchestratorStart(deps, 'cron');
    // null = 并发副本抢先建了（start 内的 cron 防重闸）——同样是"没补"，不是失败。
    return run ? { action: 'started', run } : { action: 'skipped', reason: 'run-exists' };
  } catch (err) {
    // 唯一有代价的残留：若失败发生在 run 已建、续链 send 却抛之后（`advanceAndContinue` 的
    // 「链没armed 必抛」契约），这条 run 会停在 running 且当夜不再推进。boot 路径没有 pg-boss
    // 重投递可依赖，故只能 loud log —— 次夜锚点会 abandon 它并（YUK-781 B）取消其在飞 job。
    // 触发它需要 orchestrator 队列自身的 send 在启动期就失败，那时 pg-boss 本已不可用。
    console.error(
      '[orchestrator] boot catch-up failed (non-fatal, waiting for the next anchor; a run created just before the failure may sit `running` with no tick armed)',
      err,
    );
    return { action: 'skipped', reason: 'error' };
  }
}

/**
 * 推进一步 → 完成收尾 / 未完成调度下一 tick。
 *
 * **续链保证的准确契约**（YUK-758 review 面板必修 1，经 ToTk1I / ToTvY 收紧）：
 * 本函数返回**正常**当且仅当「run 已收尾」**或**「下一 tick 已确认排队」。推进本身失败
 * （advanceRun / finishRun 抛）只要续链排上了就**吞掉**——单点失败退化成「丢一拍」，下一 tick
 * 从最新 DB 态重来（advanceRun 幂等）。但若**续链本身**没排上（send 抛 / 返回 null），本函数
 * **抛出**，把「链没armed」如实上报调用方。
 *
 * 为什么这个区分是必须的：register.ts 的 tick 分支「只 log 不 rethrow」，其正当性**完全**建立在
 * 「续链已保证」之上。早先版本把续链 send 放在 try/catch **之外**，它一抛就既没排下一拍、又被
 * 上层吞掉当作成功 —— pg-boss 认为 tick 成功、不重投递，当夜链彻底断掉，run 停在 running 直到
 * 次夜 abandon（ToTk1I）。现在「没armed 必抛」→ register 照常 rethrow → pg-boss 重投递即恢复；
 * 且此时**没有任何** tick 被排出，重投递不会分叉出并行链（分叉正是当初不 rethrow 的理由）。
 *
 * 残留边角：若 send 已在 DB 落库却在返回前抛（提交后失联），重投递会多排一条链。宁可多一条
 * 也不要零条——多链只是重复 enqueue（成员 job 侧有 CAS 领取 + 同 id 幂等兜着），零链是整夜静默。
 */
async function advanceAndContinue(
  deps: DriveDeps & { run: RunRow },
): Promise<AdvanceSummary | null> {
  // 单一 now 贯穿 advance + finish（YUK-758 review ToTai）：避免 run.finished_at 因两次独立
  // new Date() 比末节点 finished_at 略晚的时序错位。
  const now = deps.now ?? new Date();
  let summary: AdvanceSummary | null = null;
  let settled = false;
  let advanceError: unknown = null;
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
      // 收尾行只在 CAS 真赢时打（YUK-778）：两条并发 tick 可以同时判 complete，但只有一条
      // 真的转移了 run 状态。另一条无条件打日志就会让「今夜收尾」在日志里出现两次。
      if (await finishRun(deps.db, deps.run.id, 'completed', now)) {
        console.log(
          `[orchestrator] run ${deps.run.id} (${deps.run.run_date}) completed: ${describeNodeCensus(summary)}`,
        );
      }
      settled = true;
    }
  } catch (err) {
    // 先扣住——只有在确认续链排上之后才吞（见下）。
    advanceError = err;
  }

  if (!settled) {
    // 续链 send **不**包在上面的 try 里：它失败必须能抛到调用方，让 pg-boss 重投递本 tick。
    // 带上 run_id（ToTvLt）：下一拍据此直接定位本 run，跨本地午夜也不会失联。
    const tickId = await deps.boss.send(
      ORCHESTRATOR_QUEUE,
      { tick: true, runId: deps.run.id },
      { startAfter: TICK_INTERVAL_SECONDS },
    );
    if (!tickId) {
      // 返回 null = 未建 job（ToTaa）。这同样是「链没armed」，必须抛而不是只 log——只 log 会让
      // pg-boss 把本 tick 当成功、不重投递，当夜静默断链。
      throw new Error(
        `[orchestrator] next tick send returned null for run ${deps.run.id} (${deps.run.run_date}) — tick chain not armed`,
      );
    }
  }

  // 到此：run 已收尾，或下一拍已确认排队。此刻才吞掉推进失败并留 loud log——本分支是
  // **被吞掉**的失败，pg-boss 看到的是一次成功的 tick，故它不会进 DLQ（YUK-778 给
  // ORCHESTRATOR_QUEUE 加的 DLQ 只兜「抛到 pg-boss 且耗尽重试」的那一类）。日志仍是唯一出口。
  if (advanceError) {
    console.error(
      `[orchestrator] advance failed for run ${deps.run.id} (${deps.run.run_date}) — the next tick IS queued, so the chain survives; state is re-read from DB next tick`,
      advanceError,
    );
  }
  return summary;
}
