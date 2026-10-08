import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

/** Acquire before target relation lookup/DDL; release with the installer transaction. */
export async function lockProducerFenceInstaller(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('pgboss:producer-fence:install:v1', 0))`,
  );
}
