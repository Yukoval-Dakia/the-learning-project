// YUK-758 — orchestrator 挂载器（公共出口）。start-worker.ts 在 registerCapabilityJobs
// 之后调一次：建 orchestrator 队列 + work（start/tick 二态）+ 单锚点 cron。
//
// 独立模块、不向 handlers.ts 渐缩簿加肉：orchestrator 需 boss 依赖（send + getJobById），
// 与 note_verify 一类链式回调同性质，但自持队列/cron，故自带挂载器（mountSubscriptionDispatch
// 同款先例）。

import type { Job, PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import type { CapabilityManifest } from '@/kernel/manifest';
import { EXPIRE_FAST, createJobQueue } from '@/server/boss/queue-config';
import { ORCHESTRATOR_CRON, ORCHESTRATOR_QUEUE, ORCHESTRATOR_TZ } from './constants';
import { buildOrchestrationDag } from './members';
import {
  type OrchestratorBoss,
  runOrchestratorCatchUp,
  runOrchestratorStart,
  runOrchestratorTick,
} from './orchestrator';

/**
 * orchestrator 队列认得的 payload 形状：cron `{}` / tick `{tick:true, runId?}` /
 * 手动 `{trigger:'manual'}`。`runId` 只在 tick 上有意义（见 ToTvLt：跨本地午夜定位本 run）。
 */
export interface OrchestratorJobPayload {
  tick?: true;
  runId?: string;
  trigger?: 'manual';
}

/**
 * pg-boss → {@link OrchestratorBoss} 适配器（**生产**实现）。
 *
 * 独立导出而非内联在 registerOrchestrator 里（YUK-779 PR #1076 review）：内联的匿名对象
 * 字面量**任何测试都够不着**，于是 orchestrator 的 DB 测试只能注入 FakeBoss —— 而 FakeBoss
 * 是 OrchestratorBoss 的替身，它**绕过**了这个适配器。结果是「测试替身比生产实现更完整」：
 * FakeBoss 实现了 output 透传，生产适配器却把 output 丢了，测试全绿而生产链路是断的。
 * 具名导出让适配器本身成为被测对象（见 register.db.test.ts 的 toOrchestratorBoss 用例）。
 *
 * `output` 字段来源已核实到 pg-boss v12.26.1 实装（不是照猜）：
 *  · `plans.js:385` —— `JOB_COLUMNS_ALL` 里 `output` 是**不带 alias** 的裸列名
 *    （同批其它列如 `retry_limit as "retryLimit"` 都改了名，唯独 output 没有）；
 *  · `manager.js:1561-1578` —— `getJobById` 直接返回该 SELECT 的行，除 CockroachDB 的
 *    数值归一化外不做任何字段改写；
 *  · `types.d.ts` `JobWithMetadata.output: object`。
 * DB 列是 nullable jsonb，handler 返回 void 时为 `null`，故此处按 `unknown` 透传，由
 * readJobYieldReport 做防御性解析（它对 null/畸形一律返回 undefined）。
 */
export function toOrchestratorBoss(boss: PgBoss): OrchestratorBoss {
  return {
    send: (name, data, options) => boss.send(name, data, options ?? {}),
    getJobById: async (name, id) => {
      const job = await boss.getJobById(name, id);
      // YUK-779: `output` 必须透传 —— 夜链 handler 的产出报告经由它抵达
      // orchestrator 并盖进 dag_orchestration_node.detail。丢了它整条可见性链路断掉，
      // 且**不会有任何测试报警**（FakeBoss 走的是另一条路），故此处是承重的一行。
      return job ? { state: job.state, output: job.output } : null;
    },
    // YUK-781 B — v12 `cancel(name, id)` 返回 CommandResponse（affected 计数），orchestrator
    // 只关心「已尽力取消」，故丢弃返回值以保持窄接口。语义与残留风险见 OrchestratorBoss.cancel。
    cancel: async (name, id) => {
      await boss.cancel(name, id);
    },
  };
}

/**
 * orchestrator job payload 的 runtime 收窄（YUK-758 review ToTa0 + ToTe7）。
 *
 * **恰好三种形状**互斥放行：`{}`（cron 锚点）/ `{ tick: true }`（自调度 tick）/
 * `{ trigger: 'manual' }`（人工整链重跑）。其余**一律抛**——绝不猜。
 *
 * 收窄到「白名单键 + 字面值 + 互斥」而非「类型对就放行」是有代价理由的（ToTe7）：宽松版会让
 *  · `{ tick: false }` —— 类型合法但落进 else 分支 → 被当 cron **整链重跑**（付费 LLM 根节点齐发）；
 *  · `{ manual: true }` —— 未知键被忽略 → 同样落进 cron 分支，而调用方以为触发的是 manual；
 *  · `{ tick: true, trigger: 'manual' }` —— tick 优先，manual 语义被**静默吞掉**。
 * 三者都是「手滑一个字段就烧一整夜付费任务」的形状，故按未知 payload 拒绝。
 */
export function parseOrchestratorPayload(raw: unknown): OrchestratorJobPayload {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `[orchestrator] unexpected job payload (not an object): ${JSON.stringify(raw)}`,
    );
  }
  const allowed = new Set(['tick', 'runId', 'trigger']);
  const unknown = Object.keys(raw as Record<string, unknown>).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`[orchestrator] unexpected job payload key(s): ${unknown.join(', ')}`);
  }
  const { tick, runId, trigger } = raw as Record<string, unknown>;
  if (tick !== undefined && tick !== true) {
    throw new Error(
      `[orchestrator] unexpected job payload: 'tick' must be exactly true, got ${JSON.stringify(tick)}`,
    );
  }
  if (trigger !== undefined && trigger !== 'manual') {
    throw new Error(
      `[orchestrator] unexpected job payload: 'trigger' must be exactly 'manual', got ${JSON.stringify(trigger)}`,
    );
  }
  if (tick !== undefined && trigger !== undefined) {
    throw new Error(
      "[orchestrator] unexpected job payload: 'tick' and 'trigger' are mutually exclusive",
    );
  }
  if (runId !== undefined && (typeof runId !== 'string' || runId.length === 0)) {
    throw new Error(
      `[orchestrator] unexpected job payload: 'runId' must be a non-empty string, got ${JSON.stringify(runId)}`,
    );
  }
  // runId 只随 tick 走；挂在 cron/manual 上说明调用方搞错了形状，不猜。
  if (runId !== undefined && tick !== true) {
    throw new Error("[orchestrator] unexpected job payload: 'runId' is only valid with tick:true");
  }
  if (tick === true) return runId === undefined ? { tick: true } : { tick: true, runId };
  if (trigger === 'manual') return { trigger: 'manual' };
  return {};
}

/**
 * 建 orchestrator 队列 + 它的死信队列（YUK-778）。
 *
 * **为什么不能继续用 `FAST_QUEUE_OPTS`**：那份 opts 只设 expire/retention，其余全部落到
 * pg-boss 的 `QUEUE_DEFAULTS`（实测 v12.26.1，plans.js:44-53 定义 + 456-458 的
 * `COALESCE(options->>'retryLimit', 2)` 等）：`retry_limit 2 / retry_delay 0 /
 * retry_backoff false / dead_letter NULL`。FAST 档这么定是对的——housekeeping 掉一拍下个
 * cron 重跑。但 orchestrator tick 不是 housekeeping，它是**整夜唯一的驱动单点**：
 *  · `retry_delay 0` ⇒ 三次尝试在数秒内背靠背烧完。tick 失败的现实成因是 DB 抖动 / pg-boss
 *    不可用这类**有恢复时间常数**的故障，零延迟重投递恰好在故障还没过去时把预算全花光。
 *  · 无 DLQ ⇒ 预算耗尽后那条 job 直接消失，运维手上只剩 register.ts 里的一行 console.error。
 *    出事的又正是「昨晚没跑」这种事后才发现的场景——没有可查残骸就无从复盘。
 *
 * `createJobQueue` 恰好就是这套配方（先建 `<name>_dlq` 再建主队列，带 retryLimit 2 /
 * retryDelay 30 / retryBackoff true / deadLetter）。**顺序不可换**：pg-boss 的
 * `createQueue` 在 opts 带 deadLetter 时会 `await getQueueCache(deadLetter)`（manager.js:1382），
 * 且 `queue.dead_letter` 是指向 `queue(name)` 的外键（plans.js:131）——DLQ 不先存在就直接报错。
 * retryLimit 保持 2（与继承来的默认同值，零行为变更），真正的 delta 只有 retryDelay+backoff+DLQ。
 *
 * 升级路径：`createJobQueue` 内部走 `createOrUpdateQueue`，`updateQueue` 会 SET
 * retry_limit/retry_delay/retry_backoff/dead_letter（plans.js:708-731），所以这套配置也会
 * 落到**已存在**的生产队列上，不只是新库。
 *
 * DLQ 本身用 FAST 档（7d retention、不挂 worker），与仓内其它 DLQ 同形：它只是可查的残骸箱。
 * 注意 pg-boss 转投 DLQ 时用的是 **DLQ 自己**的 retention（plans.js:1755-1776 的
 * `now() + q.retention_seconds`），故 7d 是这些残骸的实际保留期。
 *
 * 具名导出而非内联（YUK-779 PR #1076 的教训）：内联在 mountOrchestrator 里的建队调用只能
 * 用 fake boss 断言"我们调了什么"，而「配置是否真的落进 pgboss.queue 行」——本项唯一要证明
 * 的东西——只有把真 pg-boss 喂给它才能验。见 register.db.test.ts 的真 pg-boss 用例。
 */
export async function ensureOrchestratorQueues(boss: PgBoss): Promise<void> {
  await createJobQueue(boss, ORCHESTRATOR_QUEUE, EXPIRE_FAST);
}

/**
 * 进程内挂载幂等闸（YUK-758 review ToTaz）：registerOrchestrator 若被同一进程调二次
 * （dev 热重载 / 调用方重复挂载），下面的 boss.work 会挂两个 worker、boss.schedule 会
 * 重复写锚点 cron —— 等于整夜双跑。`boss.schedule` 本身是 upsert（同 name 覆盖）不会真的
 * 建两条 schedule 行，但 boss.work 会真的多挂一个消费者，故仍需闸住整个挂载过程。
 */
let mounted = false;

/** 测试用：重置进程内挂载闸。 */
export function resetOrchestratorMountForTest(): void {
  mounted = false;
}

export async function registerOrchestrator(
  boss: PgBoss,
  db: Db,
  capabilities: readonly CapabilityManifest[],
): Promise<void> {
  if (mounted) {
    console.warn(
      '[orchestrator] already mounted in this process — skipping duplicate registration',
    );
    return;
  }
  const dag = buildOrchestrationDag(capabilities);
  if (dag.nodes.size === 0) {
    // 无图成员声明 → 不挂载空 cron（避免建成不通电）。
    console.log('[orchestrator] no DAG members declared — not mounted');
    return;
  }
  // 闸**在挂载真正成功之后**才落（YUK-758 review ToTbo）：若先置 true 而中途某步抛，闸会把
  // 一个**从未挂成**的 orchestrator 永久锁死——此后同进程再调只会 warn 后返回，除非整进程重启
  // 否则永无 orchestrator。start-worker.ts 目前不 catch（抛出即中止 worker 启动，尚算显性失败），
  // 但 dev 热重载或任何 catch 住的调用方会留下「进程活着、夜链全死」的静默态。故用 try/catch
  // 在失败时回滚闸，让下一次注册尝试仍可重试。
  mounted = true;
  try {
    await mountOrchestrator(boss, db, dag);
  } catch (err) {
    mounted = false;
    throw err;
  }
}

/**
 * 真正的挂载步骤。失败由调用方回滚挂载闸。
 *
 * **步骤顺序是刻意的**（YUK-758 review ToTsdt）：建队 → 清旧 schedule → 落锚点 cron →
 * **最后**才 `boss.work`。`boss.work` 注册的消费者**没有回滚路径**（挂载闸回滚只清标志位，
 * 已注册的 worker 仍在），所以它必须排在所有可能失败的步骤之后——否则「work 成功、后续步骤抛」
 * 会留下一个孤儿消费者，调用方一旦 catch 后重试就会在同队列上挂**第二个**消费者，pg-boss 把
 * 每条 orchestrator job 投给两者 → 整条夜链（含付费 LLM 根节点）双跑。
 * 反过来把 work 放最后是安全的：cron 已排但消费者还没起，只是这一拍晚几秒被 poll 到。
 */
async function mountOrchestrator(boss: PgBoss, db: Db, dag: JobDag): Promise<void> {
  await ensureOrchestratorQueues(boss);

  // 升级路径清账（YUK-758 review ToIqS）：本迁移把 14+ 只旧 cron job 改成 DAG 成员，但
  // pg-boss 的 `schedule` 行持久在 DB——已跑过旧版的实例升级后，旧 02:30/03:00/05:30… schedule
  // 仍会直接 enqueue 这些成员，与 orchestrator 双发、绕过依赖门。启动时对每个成员显式 unschedule
  // （幂等：无 schedule 行则 no-op），把「成员不得带 cron」的组合期不变量落到运行期。
  //
  // `allSettled` 而非 `all`（review ToTbt）：短路会让**未尝试**的成员静默留着旧 schedule；
  // 逐条跑完才能把清账做到最大程度、并把每个失败项都报出来。
  // 但**任一失败即中止挂载**（review ToTvLr）：先前只 warn 后照常落锚点 cron，等于放任
  // 「残留旧 cron 直发该成员 + DAG 也触发它」并存——重复付费任务且绕过依赖门，而且进程不重启
  // 就一直如此。宁可让挂载**响亮失败**（start-worker 不 catch → 启动中止，运维立刻可见），
  // 也不要带着已知的双发状态跑一整夜。闸已回滚，重启/重试即可再来。
  const members = [...dag.nodes.keys()];
  const unscheduled = await Promise.allSettled(members.map((member) => boss.unschedule(member)));
  const failedUnschedules = members.filter((_, i) => unscheduled[i].status === 'rejected');
  for (const [i, result] of unscheduled.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `[orchestrator] failed to unschedule legacy cron for DAG member '${members[i]}'`,
        result.reason,
      );
    }
  }
  if (failedUnschedules.length > 0) {
    throw new Error(
      `[orchestrator] aborting mount: could not clear legacy cron for ${failedUnschedules.length} DAG member(s) (${failedUnschedules.join(', ')}); mounting the anchor now would let them both self-fire and be orchestrated (duplicate paid jobs, dependency gate bypassed)`,
    );
  }

  // 单锚点 cron（图成员自身已无 cron，validateComposition 强制）。
  await boss.schedule(ORCHESTRATOR_QUEUE, ORCHESTRATOR_CRON, {}, { tz: ORCHESTRATOR_TZ });

  const orchestratorBoss: OrchestratorBoss = toOrchestratorBoss(boss);

  // 最后一步（见上文顺序说明）：注册消费者。
  await boss.work(
    ORCHESTRATOR_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    // pg-boss 原生 `Job` 类型（review ToTsdy）：与 verify-dispatch-outbox.ts 等既有 handler
    // 一致，也让 pg-boss 未来的形状变更被类型系统而不是运行期发现。payload 仍走
    // parseOrchestratorPayload 收窄——`Job` 的 data 是 unknown-ish，类型只保证信封不保证内容。
    async (jobs: Job[]) => {
      for (const job of jobs) {
        // 包裹 try/catch（dispatch-mount.ts 惯例，YUK-758 review ToTaR）：带上下文 log 让失败
        // 可见。日志仍是第一现场——DLQ（YUK-778）只在**重试预算耗尽后**才留下残骸，中间那
        // 两次失败的上下文只有这一行。
        // **parse 也在 try 内**（review ToTbq）：畸形 payload 的抛出同样要留下这行日志，否则
        // 恰恰是「手工 enqueue 出错」这种最需要线索的场景反而无声——与上面那句注释的立意相悖。
        //
        // **rethrow 全路径**（YUK-758 review 面板必修 1 → 经 ToTk1I / ToTvY 收紧的最终形态）。
        //
        // 中间一版曾对 tick 路径「只 log 不 rethrow」，理由是「续链已由 advanceAndContinue
        // 无条件保证，重投递只会分叉出并行 tick 链」。那个理由**有洞**：抛出可能发生在续链
        // 排上**之前**——runOrchestratorTick 里的 localDate() / getActiveRunForDate() 裸奔调用，
        // 以及续链 send 自身——此时既没排下一拍、又被吞掉当作成功，pg-boss 不重投递，当夜链
        // 彻底断掉、run 停在 running 到次夜 abandon（ToTk1I / ToTvY）。
        //
        // 现在契约收紧到：**advanceAndContinue 正常返回 ⟺ run 已收尾 或 下一拍已确认排队**。
        // 于是「异常能传到这里」本身就等价于「链没armed」，重投递是唯一恢复通道且**不会分叉**
        // （没armed 意味着没有已排出的 tick 与之竞争）。推进失败但链armed 的情形已在
        // advanceAndContinue 内部吞掉并留日志，根本到不了这里。故此处无条件 rethrow。
        try {
          // payload runtime 校验（review ToTa0 + ToTe7）：裸 `as` 会让畸形/手工 enqueue 的
          // payload 静默走进 start 分支（trigger 默认 'cron'）触发整链重跑。收窄见 parse 实现。
          const data = parseOrchestratorPayload(job.data);
          if (data.tick) {
            await runOrchestratorTick({ db, boss: orchestratorBoss, dag }, data.runId);
          } else {
            // cron（空 payload）或 manual 整链重跑。
            await runOrchestratorStart(
              { db, boss: orchestratorBoss, dag },
              data.trigger === 'manual' ? 'manual' : 'cron',
            );
          }
        } catch (err) {
          console.error('[orchestrator] job failed — rethrowing for pg-boss redelivery', err);
          throw err;
        }
      }
    },
  );

  console.log(
    `[orchestrator] mounted: ${dag.nodes.size} members / ${dag.roots.length} roots; anchor cron ${ORCHESTRATOR_CRON} ${ORCHESTRATOR_TZ}`,
  );

  // 错过锚点的启动期补跑（YUK-781 A）。**必须排在 boss.work 之后**：补跑会立刻排出第一拍 tick，
  // 消费者不在就白排一分钟。pg-boss 不重放错过的 cron（timekeeper `shouldSendIt` 只认「距上一次
  // cron 时刻 < 60s」），所以 02:30 那一刻整栈是停的 → 当夜零运行、连 run 行都没有，直到次日
  // 02:30。窗口闸 + 当日防重闸都在 runOrchestratorCatchUp 内，且它**契约上不抛**；这层 try/catch
  // 是带式加背带，照 start-worker.ts 里 reconcileStuckAiTaskRuns 的先例——排队消费的职责优先，
  // 补跑失败绝不能挡 worker boot。
  try {
    await runOrchestratorCatchUp({ db, boss: orchestratorBoss, dag });
  } catch (err) {
    console.error('[orchestrator] boot catch-up threw unexpectedly (non-fatal)', err);
  }
}
