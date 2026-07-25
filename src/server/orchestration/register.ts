// YUK-758 — orchestrator 挂载器（公共出口）。start-worker.ts 在 registerCapabilityJobs
// 之后调一次：建 orchestrator 队列 + work（start/tick 二态）+ 单锚点 cron。
//
// 独立模块、不向 handlers.ts 渐缩簿加肉：orchestrator 需 boss 依赖（send + getJobById），
// 与 note_verify 一类链式回调同性质，但自持队列/cron，故自带挂载器（mountSubscriptionDispatch
// 同款先例）。

import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { CapabilityManifest } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { ORCHESTRATOR_CRON, ORCHESTRATOR_QUEUE, ORCHESTRATOR_TZ } from './constants';
import { buildOrchestrationDag } from './members';
import { type OrchestratorBoss, runOrchestratorStart, runOrchestratorTick } from './orchestrator';

/** orchestrator 队列认得的 payload 形状（cron `{}` / tick `{tick:true}` / 手动 `{trigger:'manual'}`）。 */
export interface OrchestratorJobPayload {
  tick?: true;
  trigger?: 'manual';
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
  const entries = Object.entries(raw as Record<string, unknown>);
  const unknown = entries.filter(([k]) => k !== 'tick' && k !== 'trigger').map(([k]) => k);
  if (unknown.length > 0) {
    throw new Error(`[orchestrator] unexpected job payload key(s): ${unknown.join(', ')}`);
  }
  const { tick, trigger } = raw as Record<string, unknown>;
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
  if (tick === true) return { tick: true };
  if (trigger === 'manual') return { trigger: 'manual' };
  return {};
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
  mounted = true;

  // FAST 档（无 DLQ）：orchestrator 自身廉价；掉一拍 tick 由自调度链 / 次夜锚点自愈。
  await createOrUpdateQueue(boss, ORCHESTRATOR_QUEUE, FAST_QUEUE_OPTS);

  const orchestratorBoss: OrchestratorBoss = {
    send: (name, data, options) => boss.send(name, data, options ?? {}),
    getJobById: async (name, id) => {
      const job = await boss.getJobById(name, id);
      return job ? { state: job.state } : null;
    },
  };

  await boss.work(
    ORCHESTRATOR_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    async (jobs: { data?: unknown }[]) => {
      for (const job of jobs) {
        // payload runtime 校验（YUK-758 review ToTa0）：队列虽是内部自用（cron 发 {}、tick
        // 链发 { tick: true }、手动重跑发 { trigger: 'manual' }），但裸 `as` 会让任何畸形/
        // 手工 enqueue 的 payload 静默走进 start 分支（trigger 默认 'cron'）触发整链重跑。
        // 显式收窄：不认识的形状直接抛（pg-boss 标 failed 并留痕），不猜。
        const data = parseOrchestratorPayload(job.data);
        // 包裹 try/catch（dispatch-mount.ts 惯例，YUK-758 review ToTaR）：带上下文 log 让失败
        // 可见。orchestrator 队列走 FAST（无 DLQ），一次夜跑失败若无日志会完全无声。
        //
        // **rethrow 只给 start 路径**（YUK-758 review 面板必修 1 的配套约束）：
        //  · tick：advanceAndContinue 已**无条件**保证续排下一 tick（见 orchestrator.ts），
        //    所以 pg-boss 重投递不再是恢复手段，反而有害——FAST 队列继承 pg-boss v12 默认
        //    retry_limit=2 / retry_delay=0 / retry_backoff=false，3 次尝试数秒内背靠背烧完，
        //    每次都会再排一条 tick → 一夜留下 3 条并行 tick 链，重复 enqueue 付费成员 job。
        //    故 tick 失败只 log 不 rethrow，续链交给已排好的下一拍。
        //  · start：若 run 创建本身就失败（listActiveRuns / createRunWithNodes 抛），当夜**没有
        //    任何** tick 被排出，重投递是唯一恢复通道，故保留 rethrow。重投递不会建重复 run
        //    ——getLatestRunForDate 防重闸（ToPUE）已挡住。
        try {
          if (data.tick) {
            await runOrchestratorTick({ db, boss: orchestratorBoss, dag });
          } else {
            // cron（空 payload）或 manual 整链重跑。
            await runOrchestratorStart(
              { db, boss: orchestratorBoss, dag },
              data.trigger === 'manual' ? 'manual' : 'cron',
            );
          }
        } catch (err) {
          console.error(
            `[orchestrator] job failed (tick=${data.tick === true}, trigger=${data.trigger ?? 'cron'})`,
            err,
          );
          if (!data.tick) throw err;
        }
      }
    },
  );

  // 升级路径清账（YUK-758 review ToIqS）：本迁移把 14+ 只旧 cron job 改成 DAG 成员，但
  // pg-boss 的 `schedule` 行持久在 DB——已跑过旧版的实例升级后，旧 02:30/03:00/05:30… schedule
  // 仍会直接 enqueue 这些成员，与 orchestrator 双发、绕过依赖门。启动时对每个成员显式 unschedule
  // （幂等：无 schedule 行则 no-op），把「成员不得带 cron」的组合期不变量落到运行期。
  // 各 unschedule targets 互不相干（每条打不同 name），并发发出即可——串行 await 会把 14+ 次
  // DB 往返摞成启动期的一条长链（YUK-758 review ToTaw）。
  await Promise.all([...dag.nodes.keys()].map((member) => boss.unschedule(member)));

  // 单锚点 cron（图成员自身已无 cron，validateComposition 强制）。
  await boss.schedule(ORCHESTRATOR_QUEUE, ORCHESTRATOR_CRON, {}, { tz: ORCHESTRATOR_TZ });
  console.log(
    `[orchestrator] mounted: ${dag.nodes.size} members / ${dag.roots.length} roots; anchor cron ${ORCHESTRATOR_CRON} ${ORCHESTRATOR_TZ}`,
  );
}
