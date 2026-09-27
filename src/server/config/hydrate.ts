// YUK-1007 — 配置水合（server-only：唯一允许碰 db 的文件；读面 store.ts 纯内存）。
//
// 模式 = src/server/subjects/hydrate.ts 先例：
//   - never-throws：表未建（42P01）/ DB down / 坏行 → WARN + 保留 last-good
//     （首启 = 空快照 = 纯 env 行为，天然回滚位，§5.2）。
//   - epoch 探测：先 SELECT system_config_epoch；与快照 epoch 相同 → 跳过全量
//     SELECT（一行探测 ≈ 0 成本，§1.3）。
//   - 逐行 schema parse：未登记 key / 坏 jsonb / pinned key 各行独立 skip+WARN，
//     不拖垮整轮（§6.5）。
//   - startConfigRefresh：app + worker 都挂 15s 周期，unref 不阻退出。

import { resolveKeyDef } from '@/core/config/registry';
import {
  type ConfigSnapshotEntry,
  type ConfigValue,
  getConfigSnapshot,
  replaceConfigSnapshot,
} from '@/core/config/store';
import { type Db, db as defaultDb } from '@/db/client';
import { system_config, system_config_epoch } from '@/db/schema';

export interface ConfigHydrationReport {
  /** 本轮载入的 key（schema 通过且非 pinned）。 */
  hydrated: string[];
  skipped: Array<{ key: string; reason: string }>;
  /** true = epoch 探测同号，跳过了全量 SELECT。 */
  epochUnchanged: boolean;
  epoch: number;
}

async function readDbEpoch(db: Db): Promise<number | null> {
  const rows = await db.select({ epoch: system_config_epoch.epoch }).from(system_config_epoch);
  return rows[0]?.epoch ?? null;
}

/**
 * 全量（或 epoch-skip）水合。never-throws；返回报告供 boot 日志 / 测试断言。
 */
export async function hydrateConfigFromDb(db: Db = defaultDb): Promise<ConfigHydrationReport> {
  const report: ConfigHydrationReport = {
    hydrated: [],
    skipped: [],
    epochUnchanged: false,
    epoch: getConfigSnapshot().epoch,
  };
  try {
    const dbEpoch = await readDbEpoch(db);
    const current = getConfigSnapshot();
    if (dbEpoch !== null && dbEpoch === current.epoch) {
      report.epochUnchanged = true;
      report.epoch = dbEpoch;
      return report;
    }

    const rows = await db.select().from(system_config);
    const entries = new Map<string, ConfigSnapshotEntry>();
    for (const row of rows) {
      const def = resolveKeyDef(row.key);
      if (!def) {
        console.warn('[config] skipping unregistered key', { key: row.key });
        report.skipped.push({ key: row.key, reason: 'unregistered key' });
        continue;
      }
      if ((def.envMode ?? 'fallback') === 'pinned') {
        // compose 强制项：写端 409 拦正常路径；手工塞的行不生效也不该静默——skip+WARN。
        console.warn('[config] skipping compose-pinned key (env wins anyway)', {
          key: row.key,
        });
        report.skipped.push({ key: row.key, reason: 'compose-pinned (env wins)' });
        continue;
      }
      const parsed = def.schema.safeParse(row.value);
      if (!parsed.success) {
        console.warn('[config] row failed schema — falling back to env/default this round', {
          key: row.key,
          issues: parsed.error.issues.slice(0, 3),
        });
        report.skipped.push({ key: row.key, reason: 'schema parse failed' });
        continue;
      }
      entries.set(row.key, {
        value: parsed.data as ConfigValue,
        revision: row.revision,
        updatedAt:
          row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      });
      report.hydrated.push(row.key);
    }

    replaceConfigSnapshot({
      epoch: dbEpoch ?? 0,
      entries,
      hydratedAt: new Date().toISOString(),
    });
    report.epoch = dbEpoch ?? 0;
    return report;
  } catch (err) {
    // 42P01（migration 未跑）/ DB down：WARN + 现状即地板（纯 env/code-default）。
    console.warn('[config] hydration failed — keeping last-good / env+code floor', err);
    return report;
  }
}

/**
 * 周期刷新（app + worker 共用；15s = §1.3 建议窗——「下次调用生效」的诚实有界
 * 窗口标注）。unref 不阻退出；返回句柄供 shutdown clearInterval。
 * never-throws：hydrate 自身兜底 + 这层 catch 双保险。
 */
export function startConfigRefresh(db: Db = defaultDb, intervalMs = 15_000): { stop: () => void } {
  const timer = setInterval(() => {
    void hydrateConfigFromDb(db).catch(() => {
      // hydrate 自身 never-throws；这层 catch 只是双保险。
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
