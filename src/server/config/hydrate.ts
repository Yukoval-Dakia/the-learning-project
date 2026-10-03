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
//
// review P1-3（stale hydrate overwrite）：
//   - 单飞串行：hydrateConfigFromDb 全部走一条 promise 链——refresh 周期、写后
//     即时 hydrate、restore 后 hydrate 不复叠跑；后一个调用等前一个落定后再
//     重新读（读到的总是当时最新快照，无 ABA）。
//   - 单次一致读：epoch + 全量行用一条 SQL（隐式单语句 snapshot）取回——不许
//     「epoch 读一次、行再读一次」两半读（两条语句在 READ COMMITTED 下各自一份
//     快照，写方插队会让 epoch 与行失配）。
//   - epoch 守卫：一致读到的 epoch 若早于当前已发布 epoch → 拒绝发布（refresh
//     与 post-write hydrate 即便排队交错，也只能单调前进，不能回写旧数据）。

import { sql } from 'drizzle-orm';
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
  /** true = 一致读到的 epoch 早于已发布 epoch，按守卫拒绝发布（P1-3）。 */
  staleSkipped?: boolean;
}

async function readDbEpoch(db: Db): Promise<number | null> {
  const rows = await db.select({ epoch: system_config_epoch.epoch }).from(system_config_epoch);
  const raw = rows[0]?.epoch;
  return raw === null || raw === undefined ? null : Number(raw);
}

/** 一致读：一条语句取 epoch + 全量行（同一隐式快照，无两半读）。 */
async function readConsistentSnapshot(db: Db): Promise<{ epoch: number; rows: RawConfigRow[] }> {
  const result = await db.execute<{ epoch: number | string | null; rows: unknown }>(sql`
    select
      (select epoch from ${system_config_epoch} where id = 'global' limit 1) as epoch,
      (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.key), '[]'::jsonb)
        from ${system_config} as t
      ) as rows
  `);
  const row = result[0];
  return {
    epoch: row?.epoch === null || row?.epoch === undefined ? 0 : Number(row.epoch),
    rows: Array.isArray(row?.rows) ? (row.rows as RawConfigRow[]) : [],
  };
}

interface RawConfigRow {
  key: string;
  value: unknown;
  revision: number;
  updated_at: string | null;
}

/**
 * 单飞链：每次 hydrateConfigFromDb 都把一轮 hydrate 追加到这条链尾——
 * refresh 周期、写后即时 hydrate、restore 后 hydrate 不再并发交错。
 * 链上每一步都是「重新读」，所以即便排队靠后，拿到的也是提交时的最新快照。
 */
let hydrateChain: Promise<ConfigHydrationReport> = Promise.resolve({
  hydrated: [],
  skipped: [],
  epochUnchanged: false,
  epoch: 0,
});

/**
 * 测试 seam（第二轮 review P2）：epoch 守卫通过后、replaceConfigSnapshot 发布前
 * 的确定性 barrier。生产恒为 undefined（零开销）；测试用它精确复现「旧 hydrate
 * 在守卫检查后被挂起、新写 + 写后 hydrate 先行发布、旧 hydrate 恢复后发布旧值」
 * 的 check-then-act 竞态——串行链是该窗口的唯一闭合手段（守卫检查与发布不是
 * 原子的）。不用 sleep：barrier 由测试显式放行，时序确定。
 */
export const __hydratePublishGate: { hook?: () => Promise<void> } = {};

/**
 * 全量（或 epoch-skip）水合。never-throws；返回报告供 boot 日志 / 测试断言。
 * 提交顺序串行化：promise 链保序，链内单语句一致读 + epoch 守卫挡陈旧发布。
 */
export function hydrateConfigFromDb(db: Db = defaultDb): Promise<ConfigHydrationReport> {
  // 串行化：每个调用在链尾挂一轮新 hydrate——在跑的那轮落定后这轮才起读，
  // 排到队首时读到的是当时最新快照（无 ABA、无交叠）。
  const report = hydrateChain.then(
    () => doHydrate(db),
    () => doHydrate(db),
  );
  hydrateChain = report;
  return report;
}

async function doHydrate(db: Db): Promise<ConfigHydrationReport> {
  const report: ConfigHydrationReport = {
    hydrated: [],
    skipped: [],
    epochUnchanged: false,
    epoch: getConfigSnapshot().epoch,
  };
  try {
    // 便宜探测（§1.3）：先查 epoch——同号直接返回，省下全量 SELECT。
    const dbEpoch = await readDbEpoch(db);
    const current = getConfigSnapshot();
    if (dbEpoch !== null && dbEpoch === current.epoch) {
      report.epochUnchanged = true;
      report.epoch = dbEpoch;
      return report;
    }

    // 一条语句同时拿 epoch + 全部行（单语句隐式快照——两段读在 READ COMMITTED
    // 下会被中间写方撕成两份快照）。
    const snapshot = await readConsistentSnapshot(db);
    const entries = new Map<string, ConfigSnapshotEntry>();
    for (const row of snapshot.rows) {
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
        // jsonb_agg(to_jsonb(...)) 把 timestamptz 序列化成 ISO string——直存。
        updatedAt: row.updated_at ?? null,
      });
      report.hydrated.push(row.key);
    }

    // epoch 守卫（P1-3）：串行链已挡掉同进程并发；这层再挡「探测时刻读到新
    // epoch、一致读却落回旧值」的跨进程回退（恢复出旧备份的极端场景之外
    // 不该触发，触发了就说明有乱序写，拒绝把旧快照发布出去）。守卫比较的是
    // 发布时刻的快照（当前进程 overlay 注入也可能推快 epoch）。
    const publishedEpoch = getConfigSnapshot().epoch;
    if (snapshot.epoch < publishedEpoch) {
      console.warn('[config] refusing to publish stale snapshot', {
        snapshotEpoch: snapshot.epoch,
        publishedEpoch,
      });
      report.staleSkipped = true;
      report.epoch = publishedEpoch;
      return report;
    }

    // 守卫检查与发布之间的确定性 barrier（测试 seam，生产 no-op）：测试用它
    // 构造「守卫已通过、发布被挂起」的精确窗口；串行链保证链上后续 hydrate
    // 此时只能排队等本轮，不能插队发布——去串行后 B 会插队、A 恢复后回写旧值。
    if (__hydratePublishGate.hook) {
      await __hydratePublishGate.hook();
    }
    replaceConfigSnapshot({
      epoch: snapshot.epoch,
      entries,
      hydratedAt: new Date().toISOString(),
    });
    report.epoch = snapshot.epoch;
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
