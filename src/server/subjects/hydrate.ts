// YUK-599 (YUK-597 v3 trait 合同 §2.2 + v2 §4 承接) — 装配水合的**兼容入口**。
//
// YUK-1567：引擎本体迁至 `@/kernel/read-models/subject-hydration`（付费输入
// strict 消费者在 capability 侧，不得深 import server/subjects；kernel
// read-models 是共享 seam）。本文件保留既有 import 面与行为：
// - `hydrateSubjectRegistryFromDb` 的 `db` 缺省仍取进程 defaultDb；
// - `startSubjectRefresh` 的 60s 周期 reconcile 接线不变（worker 用）；
// - HydrationReport 保留既有四字段；逐 trait provenance 只在 kernel 读面提供。
// - TraitResolution 读面经 resolution-cache 兼容层再导出。
// 水合合同（never-throws 失败矩阵 / 降级链 / reconcileCustomIds 防御网 /
// strict 消费者读 report.resolutions）见 kernel 模块头注释。

import { type Db, db as defaultDb } from '@/db/client';
import {
  type DbOrTx,
  type HydrationReport as DetailedHydrationReport,
  hydrateSubjectRegistryFromDb as hydrateRegistry,
} from '@/kernel/read-models/subject-hydration';
import { type SubjectRegistry, getDefaultSubjectRegistry } from '@/subjects/profile';

export type HydrationReport = Pick<
  DetailedHydrationReport,
  'hydrated' | 'builtinFloor' | 'skipped' | 'removed'
>;
// 缓存与派生的权威在 kernel read-models/subject-trait-resolutions.ts
// （db-free）；这里经 resolution-cache 兼容层 re-export 维持既有 import 面
// （hydrate.db.test / 管理读面）不破。
export {
  type TraitDegradation,
  type TraitResolution,
  getSubjectTraitResolutions,
  isGeneralFallbackFor,
} from './resolution-cache';

export async function hydrateSubjectRegistryFromDb(
  db: DbOrTx = defaultDb,
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): Promise<HydrationReport> {
  const { hydrated, builtinFloor, skipped, removed } = await hydrateRegistry(db, registry);
  return { hydrated, builtinFloor, skipped, removed };
}

// worker 60s 周期全量 reconcile（level-triggered 承重路径；app 侧写后即时重装由
// YUK-600/601 写面接）。unref 不阻退出；返回句柄供 shutdown clearInterval。
export function startSubjectRefresh(db: Db = defaultDb, intervalMs = 60_000): { stop: () => void } {
  const timer = setInterval(() => {
    void hydrateSubjectRegistryFromDb(db).catch(() => {
      // hydrate 自身 never-throws；这层 catch 只是双保险。
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
