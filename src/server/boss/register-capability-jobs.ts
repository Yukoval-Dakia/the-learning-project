// M4-T3 (YUK-319) — capability jobs 注册器（kernel jobs 契约的组合根侧）。
//
// 遍历 capabilities 的 manifest.jobs.handlers，对每条**有 load** 的 JobDecl：
//   1. 按 queue 档位建队（handlers.ts 三档先例，配方共享自 queue-config.ts）：
//      llm/agent → createJobQueue（先建 `<name>_dlq` 再建主队列，1h/2h expire）；
//      fast → createOrUpdateQueue 无 DLQ（housekeeping 掉一拍下个 cron 重跑）。
//      注册器不得给 fast 档统一建 DLQ（plan Critic m3）。
//   2. boss.work(name, { pollingIntervalSeconds: 2, batchSize: 1 }, factory(db))。
//      2s/1 与 handlers.ts 全部 LLM/AGENT 注册行的显式 opts 一致；原先两条无
//      opts 的注册（knowledge_propose_nightly / knowledge_edge_propose_nightly）
//      pg-boss 默认值即 2s/1，行为等价（等价平移红线）。
//   3. 有 schedule 的 decl → boss.schedule(name, cron, {}, { tz })。
//
// 无 load 的 decl 是纯归属元数据，不被挂载（kernel JobDecl docblock）——工厂
// 签名带 boss 依赖二参（note_verify/note_generate 链式回调）或非默认 polling
// （rejudge 0.5/1s）的 job 留在 handlers.ts 渐缩簿注册，声明仍归包。
//
// 两遍遍历（顺序不变量）：先注册所有**无 schedule** 的链式/按需 job，再注册
// cron job。保留 handlers.ts 的 D5 不变量「review_plan（链式目标）建队先于
// coach_daily（链式源）」——通用化为「chain-target ready before chain-source」，
// 不依赖 capabilities 数组顺序（agency 在 practice 前，单遍会反序）。
//
// `as JobHandlerFactory` 窄化集中在此一处（kernel manifest docblock 的约定）：
// 各包工厂是 `(db: Db) => (jobs: Job<T>[]) => Promise<void>` 的具体形态，
// JobHandlerFactory 用 any 做 variance escape hatch。

import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { CapabilityManifest, JobDecl } from '@/kernel/manifest';
import {
  EXPIRE_AGENT,
  EXPIRE_FAST,
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';

const EXPIRE_BY_QUEUE = {
  llm: EXPIRE_LLM,
  agent: EXPIRE_AGENT,
  fast: EXPIRE_FAST,
} as const;

async function mountJob(boss: PgBoss, db: Db, decl: JobDecl): Promise<void> {
  // load 在调用点已被过滤非空；这里再守一道（TS 窄化）。
  if (!decl.load) return;

  if (decl.queue === 'fast') {
    await createOrUpdateQueue(boss, decl.name, FAST_QUEUE_OPTS);
  } else {
    await createJobQueue(boss, decl.name, EXPIRE_BY_QUEUE[decl.queue]);
  }

  const factory = await decl.load();
  await boss.work(decl.name, { pollingIntervalSeconds: 2, batchSize: 1 }, factory(db));

  if (decl.schedule) {
    await boss.schedule(decl.name, decl.schedule.cron, {}, { tz: decl.schedule.tz });
  }
}

/**
 * 在 registerHandlers（渐缩簿）之后调用（start-worker.ts）。挂载所有包声明的
 * 可加载 job：建队 + work + cron schedule。
 */
export async function registerCapabilityJobs(
  boss: PgBoss,
  db: Db,
  capabilities: CapabilityManifest[],
): Promise<void> {
  const decls = capabilities.flatMap((cap) => cap.jobs?.handlers ?? []).filter((d) => d.load);
  // 链式/按需（无 schedule）先注册，cron 后注册——见文件头「两遍遍历」。
  for (const decl of decls.filter((d) => !d.schedule)) {
    await mountJob(boss, db, decl);
  }
  for (const decl of decls.filter((d) => d.schedule)) {
    await mountJob(boss, db, decl);
  }
}
