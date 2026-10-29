// 装配水合的兼容入口。引擎在 `@/kernel/read-models/subject-hydration`，让
// capability 侧 strict 消费者与全局 boot/refresh 共用同一实现，而不深 import
// server/subjects。本文件保留既有 import 面：defaultDb 缺省、60s refresh 接线、
// 四字段 HydrationReport。

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
export async function hydrateSubjectRegistryFromDb(
  db: DbOrTx = defaultDb,
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): Promise<HydrationReport> {
  const { hydrated, builtinFloor, skipped, removed } = await hydrateRegistry(db, registry);
  return { hydrated, builtinFloor, skipped, removed };
}

// worker 60s 周期全量 reconcile（承重路径，不是兜底；写面在提交后即时重装）。
// unref 不阻退出；返回句柄供 shutdown clearInterval。
export function startSubjectRefresh(db: Db = defaultDb, intervalMs = 60_000): { stop: () => void } {
  const timer = setInterval(() => {
    void hydrateSubjectRegistryFromDb(db).catch(() => {
      // hydrate 自身 never-throws，这层 catch 只是双保险。
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
