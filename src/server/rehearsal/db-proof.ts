// ====================================================================
// YUK-1057 — 演练证据：DB 状态快照 / 逐字节 diff / 报告工件
// ====================================================================
//
// 「恢复出的库就是备份时的那个库」的可重跑证明原语：
//   snapshotDbState(db)   → 全量表（FK_ORDER + 运维账本 + pgboss.job）的
//                           canonical row hash + 计数清单；
//   diffDbStates(a, b)    → 表级/行级 divergence 报告（空 = 一致）；
//   writeProof(dir, name) → 工件落盘（.remember/rehearsal/… gitignored）。
//
// 非 FK_ORDER 面（migration_apply_*/contract_epoch/pgboss.job）单独入
// `operational` 分区 —— 备份载荷不含它们，它们的快照只回答
// 「运维态在演练中的真实终态」，不参与 restore-identity 断言。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { FK_ORDER } from '@/server/export/constants';

/** 备份覆盖的持久表全集（FK_ORDER）+ 演练关注的运维表。 */
const OPERATIONAL_TABLES = [
  'migration_apply_run',
  'migration_apply_phase',
  'contract_epoch',
  'event_subscription_checkpoint',
  'event_subscription_delivery',
  'event_subscription_effect',
] as const;

export interface TableProof {
  row_count: number;
  /** 该表全部行 canonical hash 的聚合 hash（空表 = hash of []）。 */
  rows_digest: string;
  /** 逐行 digest（行量小时保留明细；>5000 行表退化为 null 只留聚合）。 */
  row_digests: string[] | null;
}

export interface DbStateProof {
  taken_at: string;
  /** 备份覆盖面（FK_ORDER，逐表全行 hash）。 */
  backed_up: Record<string, TableProof>;
  /** 运维/账本面（不入备份，但演练断言面）。 */
  operational: Record<string, TableProof>;
  /** pgboss.job 概览（name×state 计数 + 行 digest 聚合）。 */
  pgboss_jobs: { present: boolean; by_state: Record<string, number>; rows_digest: string | null };
  /** 全库聚合 digest（backed_up + operational + pgboss 一起 hash）。 */
  digest: string;
}

const ROW_DIGEST_DETAIL_LIMIT = 5_000;

async function tableProof(db: Db, table: string): Promise<TableProof> {
  // 表名是 FK_ORDER/OPERATIONAL 白名单（非用户输入）—— raw 安全。
  // 排序在 JS 层做（digest 排序）：复合主键表的第一列不唯一，`order by 1`
  // 的物理序在 dump/restore 后可漂移 —— 行集合的【无序】等价才是断言面。
  const rows = (await db.execute(sql.raw(`select * from "${table}"`))) as Array<
    Record<string, unknown>
  >;
  const digests = rows.map((r) => canonicalHash(r)).sort();
  return {
    row_count: rows.length,
    rows_digest: canonicalHash(digests),
    row_digests: rows.length <= ROW_DIGEST_DETAIL_LIMIT ? digests : null,
  };
}

/** 拍一份全量状态证明（同一连接内顺序读 —— 快照一致性由演练编排的停写窗口保证）。 */
export async function snapshotDbState(db: Db): Promise<DbStateProof> {
  const backedUp: Record<string, TableProof> = {};
  for (const t of FK_ORDER) {
    backedUp[t] = await tableProof(db, t);
  }
  const operational: Record<string, TableProof> = {};
  for (const t of OPERATIONAL_TABLES) {
    // 表可能不存在（pgboss/账本在未跑的库上缺）→ 记 row_count=-1 哨兵。
    try {
      operational[t] = await tableProof(db, t);
    } catch {
      operational[t] = { row_count: -1, rows_digest: canonicalHash('absent'), row_digests: null };
    }
  }
  let pgboss: DbStateProof['pgboss_jobs'];
  try {
    const jobRows = (await db.execute(
      sql`select name, state, data, retry_limit, created_on from pgboss.job order by id`,
    )) as Array<Record<string, unknown>>;
    const byState: Record<string, number> = {};
    for (const r of jobRows) {
      const key = `${String(r.name)}:${String(r.state)}`;
      byState[key] = (byState[key] ?? 0) + 1;
    }
    pgboss = {
      present: true,
      by_state: byState,
      rows_digest: canonicalHash(jobRows),
    };
  } catch {
    pgboss = { present: false, by_state: {}, rows_digest: null };
  }
  return {
    taken_at: new Date().toISOString(),
    backed_up: backedUp,
    operational,
    pgboss_jobs: pgboss,
    digest: canonicalHash({ backed_up: backedUp, operational, pgboss_jobs: pgboss }),
  };
}

export interface DbStateDiff {
  identical: boolean;
  divergences: string[];
}

/** 逐表比对两份快照（行数 + rows_digest + 逐行明细定位）。 */
export function diffDbStates(a: DbStateProof, b: DbStateProof): DbStateDiff {
  const divergences: string[] = [];
  const comparePartition = (
    label: string,
    pa: Record<string, TableProof>,
    pb: Record<string, TableProof>,
  ) => {
    for (const table of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      const ta = pa[table];
      const tb = pb[table];
      if (ta === undefined || tb === undefined) {
        divergences.push(`${label}.${table}: 缺失一侧（${ta ? 'a-only' : 'b-only'}）`);
        continue;
      }
      if (ta.row_count !== tb.row_count) {
        divergences.push(`${label}.${table}: row_count ${ta.row_count} vs ${tb.row_count}`);
      }
      if (ta.rows_digest !== tb.rows_digest) {
        divergences.push(
          `${label}.${table}: rows_digest ${ta.rows_digest.slice(0, 12)} vs ${tb.rows_digest.slice(0, 12)}`,
        );
        if (ta.row_digests && tb.row_digests) {
          const onlyA = ta.row_digests.filter((d) => !tb.row_digests?.includes(d));
          const onlyB = tb.row_digests.filter((d) => !ta.row_digests?.includes(d));
          for (const d of onlyA.slice(0, 3))
            divergences.push(`${label}.${table}: row a-only ${d.slice(0, 12)}`);
          for (const d of onlyB.slice(0, 3))
            divergences.push(`${label}.${table}: row b-only ${d.slice(0, 12)}`);
        }
      }
    }
  };
  comparePartition('backed_up', a.backed_up, b.backed_up);
  comparePartition('operational', a.operational, b.operational);
  if (a.pgboss_jobs.rows_digest !== b.pgboss_jobs.rows_digest) {
    divergences.push(
      `pgboss.job: ${a.pgboss_jobs.rows_digest?.slice(0, 12) ?? 'absent'} vs ${b.pgboss_jobs.rows_digest?.slice(0, 12) ?? 'absent'}`,
    );
  }
  return { identical: divergences.length === 0, divergences };
}

/** 工件落盘（JSON pretty；目录自动创建 —— .remember/rehearsal/ gitignored）。 */
export function writeProof(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
