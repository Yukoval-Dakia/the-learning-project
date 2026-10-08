import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

// Full public-table contents, including projections/outboxes beyond the read sources.
export async function diagnosticsPublicSnapshot(db: Db | Tx) {
  const tables = await db.execute<{ table_name: string }>(sql`
    select tablename as table_name from pg_tables where schemaname = 'public' order by tablename
  `);
  const snapshot: Record<string, string> = {};
  for (const { table_name } of tables) {
    const rows = await db.execute<{ digest: string }>(sql`
      select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest
      from ${sql.identifier(table_name)} t
    `);
    snapshot[table_name] = rows[0].digest;
  }
  return snapshot;
}
