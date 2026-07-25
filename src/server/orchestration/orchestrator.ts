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
      await updateNodeStatus(deps.db, node.id, {
        status: 'skipped',
        detail: 'job is no longer a DAG member in the running build (manifest changed mid-run)',
        now,
      });
      node.status = 'skipped';
      return false;
    }

    const upstreams = dagNode.deps.map((d) => ({ soft: d.soft, job: d.job, up: nodes.get(d.job) }));

    // 防御：硬上游是当前图成员但本 run 查不到它的节点行。正常路径下 tick/start 的 insertNodes
    // 补齐已消灭这种态（ToTk1N），此处是**最后一道**——若它仍发生，`allTerminal` 会因
    // `u.up &&` 恒 false 让本节点永久 pending、run 卡 running 空转（ToTvT）。按 skipped 语义
    // 收敛并留因，绝不留下无法收敛的 run。
    const missingHard = upstreams.find((u) => !u.soft && !u.up);
    if (missingHard) {
      await updateNodeStatus(deps.db, node.id, {
        status: 'skipped',
        detail: `upstream '${missingHard.job}' has no node row in this run`,
        now,
      });
      node.status = 'skipped';
      return false;
    }

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
      return false;
    }

    // 全部上游终态才可推进（否则等待）。根（无上游）此处 vacuous-true 即刻入队。
    // **软**上游缺节点行时视作「已终态但未成功」——不阻塞推进（软边的本意就是上游不成功也照跑），
    // 否则同样会把本节点钉死在 pending 上（ToTvT 的软边侧）。硬上游缺行已在上面收敛为 skipped。
    const allTerminal = upstreams.every((u) => (u.up ? isTerminalNodeStatus(u.up.status) : u.soft));
    if (!allTerminal) return false;

    // 到此硬上游必全 succeeded（否则被 blocked 拦）。软上游未 succeeded（含缺行）→ stale。
    const stale = upstreams.some((u) => u.soft && (!u.up || u.up.status !== 'succeeded'));

    // 先原子领取（CAS pending→enqueued），只有赢家 send——杜绝并发 advanceRun 重复付费入队
    //（YUK-758 review ToTaj）。领取失败 = 已被并发调用推进，跳过。
    // **意图先落库**（review ToTaI）：预生成 pg-boss job id 并随 CAS 一起写入节点行，之后
    // 才 send（带该 id）。这样不存在「job 已建但节点不知其 id」的窗口——崩溃重投递后
    // 总能靠 boss_job_id 查到真实 job 态，不会把在跑的成员误判超时 failed。
    const bossJobId = randomUUID();
    const claimed = await claimNodePending(deps.db, node.id, { bossJobId, stale, now });
    if (!claimed) return false;

    // 同轮第 n 个入队者延后 n×间隔（封顶）。第 0 个立刻发 → 串行链上零延迟。
    const startAfter = Math.min(staggerIndex * LAYER_STAGGER_SECONDS, LAYER_STAGGER_MAX_SECONDS);
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
      await finishRun(deps.db, deps.run.id, 'completed', now);
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

  // 到此：run 已收尾，或下一拍已确认排队。此刻才吞掉推进失败并留 loud log
  // （FAST 队列无 DLQ，无日志即全无声）。
  if (advanceError) {
    console.error(
      `[orchestrator] advance failed for run ${deps.run.id} (${deps.run.run_date}) — the next tick IS queued, so the chain survives; state is re-read from DB next tick`,
      advanceError,
    );
  }
  return summary;
}
