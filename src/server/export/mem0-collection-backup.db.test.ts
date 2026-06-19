// YUK-355 (D17「数据可丢」推翻续) — mem0 collection 备份/恢复 round-trip (testcontainer).
//
// The mem0 pgvector collection table (default `learning_project_memories`) is
// created at runtime by mem0's PGVector provider — NOT a drizzle-managed table, so
// it is absent from FK_ORDER and the schema-derived COLUMN_ALLOWLIST. Before YUK-355
// the backup only carried memory_reconciliation_log (the WAL/provenance); the
// collection bodies themselves silently vanished on restore ("备 WAL 不备 collection
// 是半截", rethink gate §1.6 / acceptance seam e). These tests exercise the dedicated
// dump/restore branch in archive.ts against a real Postgres+pgvector, including the
// pgvector `vector::text` dump / `::vector` re-insert and the soft-supersede payload.
//
// We mimic reconcile-store.db.test.ts: create the mem0 collection manually (it is
// not in any migration) under a test-specific collection name driven through
// MEM0_PGVECTOR_COLLECTION, which both buildBackupArchive and restoreFromArchive
// resolve via mem0CollectionTable().

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

const COLLECTION = 'test_mem0_backup_collection';
const DIMS = 1024;

let prevCollectionEnv: string | undefined;

async function createCollection() {
  const db = testDb();
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
  await db.execute(
    sql.raw(`
      CREATE TABLE "${COLLECTION}" (
        id uuid PRIMARY KEY,
        vector vector(${DIMS}),
        payload jsonb
      )
    `),
  );
}

async function seedRow(id: string, vector: number[], payload: Record<string, unknown>) {
  const db = testDb();
  await db.execute(sql`
    INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, vector, payload)
    VALUES (${id}::uuid, ${`[${vector.join(',')}]`}::vector, ${JSON.stringify(payload)}::jsonb)
  `);
}

async function readRows(): Promise<Array<{ id: string; vector: string; payload: unknown }>> {
  const db = testDb();
  return (await db.execute(sql`
    SELECT id::text AS id, vector::text AS vector, payload
    FROM ${sql.raw(`"${COLLECTION}"`)}
    ORDER BY id
  `)) as Array<{ id: string; vector: string; payload: unknown }>;
}

async function buildZipBytes(): Promise<Uint8Array> {
  const { stream } = await buildBackupArchive({ db: testDb(), r2: memR2(), includeAssets: false });
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

describe('mem0 collection backup/restore round-trip (YUK-355)', () => {
  beforeAll(() => {
    prevCollectionEnv = process.env.MEM0_PGVECTOR_COLLECTION;
    process.env.MEM0_PGVECTOR_COLLECTION = COLLECTION;
  });

  afterAll(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    if (prevCollectionEnv === undefined) delete process.env.MEM0_PGVECTOR_COLLECTION;
    else process.env.MEM0_PGVECTOR_COLLECTION = prevCollectionEnv;
  });

  beforeEach(async () => {
    await resetDb();
    await createCollection();
  });

  afterEach(async () => {
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
  });

  it('dumps the mem0 collection into data.json under its resolved table name', async () => {
    const vec = Array.from({ length: DIMS }, (_, i) => (i % 7) * 0.01);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, {
      data: 'User prefers terse feedback',
      user_id: 'self',
      hash: 'h1',
    });

    const bytes = await buildZipBytes();
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;

    expect(data[COLLECTION]).toBeDefined();
    expect(data[COLLECTION]).toHaveLength(1);
    const row = data[COLLECTION][0];
    expect(row.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    // vector dumped as a string (vector::text) — never a number[] in JSON.
    expect(typeof row.vector).toBe('string');
    expect(row.payload).toMatchObject({ data: 'User prefers terse feedback', user_id: 'self' });

    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json'])) as {
      row_counts: Record<string, number>;
    };
    expect(manifest.row_counts[COLLECTION]).toBe(1);
  });

  it('restores mem0 collection rows wiped between dump and restore (the data-loss hole)', async () => {
    const vec1 = Array.from({ length: DIMS }, (_, i) => Math.sin(i) * 0.001);
    const vec2 = Array.from({ length: DIMS }, (_, i) => Math.cos(i) * 0.002);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec1, {
      data: 'prefers dark mode',
      user_id: 'self',
    });
    await seedRow('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', vec2, {
      data: 'weak on integration by parts',
      user_id: 'self',
      superseded_by: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });

    const before = await readRows();
    expect(before).toHaveLength(2);

    const bytes = await buildZipBytes();

    // Simulate disaster: collection wiped (the exact loss restore must heal).
    await testDb().execute(sql.raw(`DELETE FROM "${COLLECTION}"`));
    expect(await readRows()).toHaveLength(0);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(res.status).toBe(200);

    const after = await readRows();
    expect(after).toHaveLength(2);
    // payload (incl. soft-supersede marker) round-trips intact.
    const byId = new Map(after.map((r) => [r.id, r.payload as Record<string, unknown>]));
    expect(byId.get('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toMatchObject({
      data: 'prefers dark mode',
    });
    expect(byId.get('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toMatchObject({
      superseded_by: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    // vector round-trips: still a valid pgvector of the right dimensionality.
    for (const r of after) {
      expect(r.vector.startsWith('[')).toBe(true);
      expect(r.vector.split(',').length).toBe(DIMS);
    }
  });

  it('restore stats include the mem0 collection insert count', async () => {
    const vec = Array.from({ length: DIMS }, () => 0);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, { data: 'x', user_id: 'self' });
    const bytes = await buildZipBytes();

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(res.status).toBe(200);
    const body = res.body as { stats: Record<string, { inserted: number }> };
    expect(body.stats[COLLECTION]?.inserted).toBe(1);
  });

  it('a backup taken with the mem0 table absent omits the key and restores cleanly', async () => {
    // Fresh DB where mem0 never self-initialised: no collection table at all.
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));

    const bytes = await buildZipBytes();
    const { unzipSync } = await import('fflate');
    const data = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])) as Record<
      string,
      unknown
    >;
    // No key when the table does not exist — dump skips it gracefully.
    expect(data[COLLECTION]).toBeUndefined();

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(res.status).toBe(200);
  });
});
