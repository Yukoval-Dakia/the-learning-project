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

export async function registerOrchestrator(
  boss: PgBoss,
  db: Db,
  capabilities: readonly CapabilityManifest[],
): Promise<void> {
  const dag = buildOrchestrationDag(capabilities);
  if (dag.nodes.size === 0) {
    // 无图成员声明 → 不挂载空 cron（避免建成不通电）。
    console.log('[orchestrator] no DAG members declared — not mounted');
    return;
  }

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
        const data = (job.data ?? {}) as { tick?: boolean; trigger?: 'manual' };
        // 包裹 try/catch（dispatch-mount.ts 惯例，YUK-758 review ToTaR）：带上下文 log 后
        // rethrow，让 pg-boss 标 job failed 并可见。orchestrator 队列走 FAST（无 DLQ），一次
        // 夜跑失败若无日志会完全无声——rethrow 保留 pg-boss 默认重投递 + 这行错误痕迹。
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
          throw err;
        }
      }
    },
  );

  // 升级路径清账（YUK-758 review ToIqS）：本迁移把 14+ 只旧 cron job 改成 DAG 成员，但
  // pg-boss 的 `schedule` 行持久在 DB——已跑过旧版的实例升级后，旧 02:30/03:00/05:30… schedule
  // 仍会直接 enqueue 这些成员，与 orchestrator 双发、绕过依赖门。启动时对每个成员显式 unschedule
  // （幂等：无 schedule 行则 no-op），把「成员不得带 cron」的组合期不变量落到运行期。
  for (const member of dag.nodes.keys()) {
    await boss.unschedule(member);
  }

  // 单锚点 cron（图成员自身已无 cron，validateComposition 强制）。
  await boss.schedule(ORCHESTRATOR_QUEUE, ORCHESTRATOR_CRON, {}, { tz: ORCHESTRATOR_TZ });
  console.log(
    `[orchestrator] mounted: ${dag.nodes.size} members / ${dag.roots.length} roots; anchor cron ${ORCHESTRATOR_CRON} ${ORCHESTRATOR_TZ}`,
  );
}
