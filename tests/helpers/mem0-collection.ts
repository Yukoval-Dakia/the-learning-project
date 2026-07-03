import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

// YUK-557 (F7) — shared DDL/seed helpers for the mem0 pgvector collection table.
// The collection (e.g. `learning_project_memories`) is created at RUNTIME by mem0's
// PGVector provider — it is NOT a drizzle-managed table, so DB tests that exercise
// reconcile / backup must create it by hand. Absorbs the three duplicated copies
// (reconcile-store.db.test, reconcile-handler.db.test, mem0-collection-backup.db.test).
// The tombstone integration test deliberately does NOT use this (it builds the real
// table via `new Memory(config)` to prove the official-delete tombstone path).

function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe mem0 collection name for test DDL: ${JSON.stringify(name)}`);
  }
}

/** DROP (if present, from a prior run) + CREATE a fresh mem0 collection table. */
export async function createMem0Collection(db: Db, name: string, dims = 1024): Promise<void> {
  assertSafeName(name);
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
  await db.execute(
    sql.raw(`
      CREATE TABLE "${name}" (
        id uuid PRIMARY KEY,
        vector vector(${dims}),
        payload jsonb
      )
    `),
  );
}

/**
 * Seed one collection row. `vector` is optional — omit it for reconcile tests
 * (whose apply/capture paths read only payload) and pass it for backup round-trip
 * tests (which dump/restore the vector column).
 */
export async function seedMem0Row(
  db: Db,
  name: string,
  id: string,
  payload: Record<string, unknown>,
  vector?: number[],
): Promise<void> {
  assertSafeName(name);
  if (vector) {
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${name}"`)} (id, vector, payload)
      VALUES (${id}::uuid, ${`[${vector.join(',')}]`}::vector, ${JSON.stringify(payload)}::jsonb)
    `);
  } else {
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${name}"`)} (id, payload)
      VALUES (${id}::uuid, ${JSON.stringify(payload)}::jsonb)
    `);
  }
}
