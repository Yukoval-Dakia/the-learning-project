import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { ToolCallerActor } from '@/kernel/tools/types';

/** Measure the full tool on owned synthetic data while the separate role change is unmerged. */
export async function searchBenchmarkActor(db: Db, consumer: string): Promise<ToolCallerActor> {
  if (!process.argv.includes('--owned-private-fixture')) return { kind: 'agent', ref: consumer };
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.argv.includes('--nas') ||
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    target.port !== '5434' ||
    target.pathname !== '/loom_dev_yuk1986_v3_ready'
  )
    throw Error('Owner-role measurement is limited to the writer-owned synthetic dev fixture');
  const [rows] = await db.execute(sql`SELECT count(*) AS total,
    count(*) FILTER (WHERE id NOT LIKE 'sb1986:%' OR
      metadata->>'synthetic_search_fixture' IS DISTINCT FROM 'true') AS foreign_rows FROM question`);
  if (Number(rows.total) !== 475 || Number(rows.foreign_rows) !== 0)
    throw Error('Owner-role benchmark requires the frozen 475-question synthetic corpus');
  return { kind: 'user', ref: 'owned-synthetic-bank-benchmark' };
}
