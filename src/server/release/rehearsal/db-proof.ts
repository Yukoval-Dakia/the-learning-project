// Proof that a restored database matches the backup.
// Operational tables are not in the backup payload.
// Their snapshot records the rehearsal's final ops state and is not part of the restore-identity check.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { FK_ORDER } from '@/server/export/constants';

/** Operational tables. They are not the backup payload. */
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
  /** Hash of the per-row hashes. An empty table hashes []. */
  rows_digest: string;
  /** Per-row digests, or null above 5000 rows. */
  row_digests: string[] | null;
}

export interface DbStateProof {
  taken_at: string;
  /** Full-row hashes of the backup tables. */
  backed_up: Record<string, TableProof>;
  /** Final ops state. Not part of the restore-identity check. */
  operational: Record<string, TableProof>;
  /** pgboss.job counts by name and state, plus a row digest. */
  pgboss_jobs: { present: boolean; by_state: Record<string, number>; rows_digest: string | null };
  /** Hash of backed_up, operational, and pgboss together. */
  digest: string;
}

const ROW_DIGEST_DETAIL_LIMIT = 5_000;

async function tableProof(db: Db, table: string): Promise<TableProof> {
  // Names come from the FK_ORDER and OPERATIONAL whitelists, not user input.
  // Sort digests in JS. A composite primary key's first column is not unique,
  // so ORDER BY 1 can change after restore.
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

/**
 * Read every table on this connection.
 * Consistency is the rehearsal write-stop window, not the connection.
 */
export async function snapshotDbState(db: Db): Promise<DbStateProof> {
  const backedUp: Record<string, TableProof> = {};
  for (const t of FK_ORDER) {
    backedUp[t] = await tableProof(db, t);
  }
  const operational: Record<string, TableProof> = {};
  for (const t of OPERATIONAL_TABLES) {
    // A missing table, before pgboss or the ledger exists, is row_count=-1.
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

/** Compare row counts and digests. A miss names the table. */
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

/** Write pretty JSON. The caller picks the directory. */
export function writeProof(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
