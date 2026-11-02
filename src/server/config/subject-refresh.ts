// worker 60s 周期全量科目装配 reconcile（承重路径，不是兜底；写面在提交后即时重装）。
// unref 不阻退出；返回句柄供 shutdown clearInterval。

import { type Db, db as defaultDb } from '@/db/client';
import { hydrateSubjectRegistryFromDb } from '@/kernel/read-models/subject-hydration';

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
