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
        if (data.tick) {
          await runOrchestratorTick({ db, boss: orchestratorBoss, dag });
        } else {
          // cron（空 payload）或 manual 整链重跑。
          await runOrchestratorStart(
            { db, boss: orchestratorBoss, dag },
            data.trigger === 'manual' ? 'manual' : 'cron',
          );
        }
      }
    },
  );

  // 单锚点 cron（图成员自身已无 cron，validateComposition 强制）。
  await boss.schedule(ORCHESTRATOR_QUEUE, ORCHESTRATOR_CRON, {}, { tz: ORCHESTRATOR_TZ });
  console.log(
    `[orchestrator] mounted: ${dag.nodes.size} members / ${dag.roots.length} roots; anchor cron ${ORCHESTRATOR_CRON} ${ORCHESTRATOR_TZ}`,
  );
}
