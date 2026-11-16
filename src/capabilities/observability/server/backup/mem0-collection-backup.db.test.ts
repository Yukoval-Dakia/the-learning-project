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
// Create the mem0 collection manually (it is
// not in any migration) under a test-specific collection name driven through
// MEM0_PGVECTOR_COLLECTION, which both buildBackupArchive and restoreFromArchive
// resolve via mem0CollectionTable().

import { sql } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hydrateConfigFromDb } from '@/core/config/server/hydrate';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { createMem0Collection, seedMem0Row } from '../../../../../tests/helpers/mem0-collection';
import { memR2 } from '../../../../../tests/helpers/r2';
import {
  type RestoreFromArchiveOpts,
  buildBackupArchive,
  restoreFromArchive as restoreArchive,
} from './archive';

// Restores here re-read config through the same hydrator the API composition root injects.
const restoreFromArchive = (opts: Omit<RestoreFromArchiveOpts, 'hydrateConfig'>) =>
  restoreArchive({ ...opts, hydrateConfig: hydrateConfigFromDb });

const COLLECTION = 'test_mem0_backup_collection';
const DIMS = 1024;

let prevCollectionEnv: string | undefined;

// YUK-557 (F7): DDL/seed delegate to the shared tests/helpers/mem0-collection
// (seed passes the vector via the optional param). readRows stays local (the
// backup round-trip's vector::text read is specific to this suite).
async function createCollection() {
  await createMem0Collection(testDb(), COLLECTION, DIMS);
}

async function seedRow(id: string, vector: number[], payload: Record<string, unknown>) {
  await seedMem0Row(testDb(), COLLECTION, id, payload, vector);
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

describe('mem0 collection backup/restore round-trip', () => {
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

  // @invariant data: the mem0 collection is dumped into data.json under its resolved table name
  // @fails-if the collection is dumped under the wrong key or omitted
  it('dumps the mem0 collection into data.json under its resolved table name', async () => {
    const vec = Array.from({ length: DIMS }, (_, i) => (i % 7) * 0.01);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, {
      data: 'User prefers terse feedback',
      user_id: 'self',
      hash: 'h1',
    });

    const bytes = await buildZipBytes();
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

  // @invariant data: mem0 rows wiped between dump and restore are restored — the data-loss hole is closed
  // @fails-if wiped collection rows are not restored
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

  // @invariant data: a backup taken with the mem0 table absent omits the key and restores cleanly
  // @fails-if an absent table produces a malformed entry or fails the restore
  it('a backup taken with the mem0 table absent omits the key and restores cleanly', async () => {
    // Fresh DB where mem0 never self-initialised: no collection table at all.
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));

    const bytes = await buildZipBytes();
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
// ─── malformed mem0 entry must FAIL the whole
// restore atomically, BEFORE any wipe — never silently skip the mem0 collection. ──
//
// THE BUG: at the top of restoreFromArchive, mem0Rows is computed as
//   const mem0Rows = Array.isArray(data[mem0Table]) ? data[mem0Table] : undefined;
// A data.json whose mem0 key is PRESENT but NOT an array (object/string/number)
// collapsed mem0Rows to `undefined` — indistinguishable from the legitimate ABSENT
// case. So NO shape error was raised before the FK_ORDER wipe (every FK_ORDER table
// IS preflight shape-validated for "not an array"), the FK_ORDER business tables
// were still wiped + reloaded, and the mem0 collection restore branch was SILENTLY
// skipped: a silent recoverability break — exactly what a backup must never do.
//
// FIX: give the mem0 collection entry the SAME present-but-not-an-array preflight
// shape validation the FK_ORDER tables get; a PRESENT-but-non-array mem0 key throws
// a `data_validation_failed` shape error BEFORE any wipe (whole restore aborts
// atomically). The ABSENT case (key missing) stays a graceful skip.
describe('mem0 collection malformed-entry preflight', () => {
  let prevCollectionEnv: string | undefined;

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

  // Seed a real business-table (FK_ORDER) row so we can prove restore did NOT wipe it.
  async function seedKnowledgeRow(id: string) {
    await testDb().execute(sql`
      INSERT INTO knowledge (id, name, created_at, updated_at)
      VALUES (${id}, ${'canary-node'}, now(), now())
    `);
  }

  async function countKnowledge(): Promise<number> {
    const rows = (await testDb().execute(
      sql.raw('select count(*)::int as c from knowledge'),
    )) as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  // Take a real archive, then rewrite data.json so the mem0 collection key is PRESENT
  // but NOT an array. Re-zip with the original (correct schema_version) manifest so
  // restore reaches the shape-validation pre-flight rather than bailing earlier.
  function malformMem0Entry(bytes: Uint8Array, malformed: unknown): Uint8Array {
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      unknown
    >;
    data[COLLECTION] = malformed; // present but NOT an array
    const repacked: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      repacked[name] =
        name === 'data.json' ? new TextEncoder().encode(JSON.stringify(data)) : content;
    }
    return zipSync(repacked);
  }

  // @invariant security: a present-but-malformed mem0 entry throws a shape error before any wipe
  // @fails-if the wipe runs before the mem0 shape check
  it('THROWS a shape error BEFORE wiping when the mem0 key is present-but-not-an-array', async () => {
    await seedRow(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      Array.from({ length: DIMS }, () => 0),
      {
        data: 'pre-existing mem0',
        user_id: 'self',
      },
    );
    await seedKnowledgeRow('canary-1');
    expect(await countKnowledge()).toBe(1);

    const good = await buildZipBytes();
    // Malformed: an OBJECT where an array of rows is expected.
    const bad = malformMem0Entry(good, { rows: 'oops, not an array' });

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes: bad });

    // Hard 400 shape error, mirroring how an FK_ORDER "not an array" entry fails.
    expect(res.status).toBe(400);
    const body = res.body as { error: string; issues?: string[] };
    expect(body.error).toBe('data_validation_failed');
    expect(body.issues?.some((i) => i === `${COLLECTION}: not an array`)).toBe(true);

    // CRITICAL: aborted BEFORE any wipe — the FK_ORDER business table survives intact.
    expect(await countKnowledge()).toBe(1);
    // And the mem0 collection was NOT silently dropped: its row is untouched.
    expect(await readRows()).toHaveLength(1);
  });

  // @invariant security: string and number mem0 entries are rejected before wiping
  // @fails-if a non-array mem0 entry reaches the wipe
  it('also rejects a present-but-string and present-but-number mem0 entry before wiping', async () => {
    await seedKnowledgeRow('canary-2');
    const good = await buildZipBytes();

    for (const malformed of ['a bare string', 42]) {
      const bad = malformMem0Entry(good, malformed);
      const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes: bad });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('data_validation_failed');
      // No wipe on any of the malformed shapes.
      expect(await countKnowledge()).toBe(1);
    }
  });

  // @invariant data: an absent mem0 key gracefully skips collection restore on a fresh DB
  // @fails-if a missing key is treated as an error or creates a phantom table
  it('the ABSENT mem0 case still graceful-skips (no key → fresh DB, restore ok)', async () => {
    await seedKnowledgeRow('canary-3');
    // Drop the table so buildBackupArchive omits the mem0 key entirely (absent case).
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));

    const bytes = await buildZipBytes();
    const data = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(data, COLLECTION)).toBe(false);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    // Graceful: absent key is not a shape error; restore proceeds and re-inserts the
    // business row from the archive (wipe + reload of FK_ORDER happened normally).
    expect(res.status).toBe(200);
    expect(await countKnowledge()).toBe(1);
  });
});

// ─── table-ABSENT restore must RE-CREATE
// the collection and RESTORE the rows — never silently skip backed-up mem0 data. ──
//
// THE BUG: the restore mem0 branch was gated
//   if (mem0Rows && (await mem0CollectionExists(db, mem0Table))) { ... }
// If the archive HAS mem0 rows (collection was backed up while the table existed)
// but the TARGET DB lacks the collection table (fresh DB / mem0 never lazy-init —
// the canonical disaster-recovery scenario), mem0CollectionExists() is false → the
// rows are SILENTLY skipped → backed-up mem0 data is NOT restored. That is the exact
// "不可丢必须可恢复" recoverability hole YUK-355 exists to close (D17 reversal).
//
// FIX (create-then-insert, NOT silent skip): when mem0Rows is a NON-EMPTY array but
// the target lacks the collection table, CREATE the table first (replicate mem0
// createCol: id uuid primary key, vector vector(<dims>), payload jsonb), inferring
// <dims> from the element count of the first archived row vector. Then insert. If the
// dims cannot be determined (malformed vector), FAIL LOUDLY (data_validation) rather
// than silent-skip or create a wrong-dim table. The empty/absent case stays a no-op.
describe('mem0 collection table-ABSENT restore re-creates + restores', () => {
  let prevCollectionEnv: string | undefined;

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

  async function tableExists(): Promise<boolean> {
    const rows = (await testDb().execute(
      sql`select to_regclass(${`public.${COLLECTION}`}) as reg`,
    )) as Array<{ reg: string | null }>;
    return rows[0]?.reg !== null && rows[0]?.reg !== undefined;
  }

  // Take a real archive, then rewrite data.json's mem0 collection rows (e.g. to inject
  // a malformed vector). Re-zip with the original manifest so restore reaches the
  // dump branch rather than bailing on schema_version/zip errors.
  function rewriteMem0Rows(bytes: Uint8Array, rows: Array<Record<string, unknown>>): Uint8Array {
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      unknown
    >;
    data[COLLECTION] = rows;
    const repacked: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      repacked[name] =
        name === 'data.json' ? new TextEncoder().encode(JSON.stringify(data)) : content;
    }
    return zipSync(repacked);
  }

  // @invariant data: restore re-creates an absent mem0 collection with the correct dims and restores its rows
  // @fails-if the collection is re-created with wrong dims or rows are skipped
  it('RE-CREATES the collection with the correct dims AND restores rows when the target table is absent', async () => {
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

    // Archive captured WHILE the table existed (2 rows present in data.json).
    const bytes = await buildZipBytes();

    // Disaster-recovery target: the collection table does NOT exist at all (fresh DB,
    // mem0 never lazy-initialised). This is the silent-skip hole.
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
    expect(await tableExists()).toBe(false);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(res.status).toBe(200);

    // The table is RE-CREATED…
    expect(await tableExists()).toBe(true);
    // …with the correct dimensionality (inferred from the archived vector)…
    const dimsRow = (await testDb().execute(
      sql`select a.atttypmod as typmod
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          where c.relname = ${COLLECTION} and a.attname = 'vector'`,
    )) as Array<{ typmod: number }>;
    // pgvector stores the declared dim verbatim in atttypmod (no +4 VARLENA offset).
    expect(dimsRow[0]?.typmod).toBe(DIMS);

    // …and the backed-up rows are ACTUALLY restored (the round-trip survives a
    // table-absent target — the recoverability contract).
    const after = await readRows();
    expect(after).toHaveLength(2);
    const byId = new Map(after.map((r) => [r.id, r.payload as Record<string, unknown>]));
    expect(byId.get('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toMatchObject({
      data: 'prefers dark mode',
    });
    expect(byId.get('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toMatchObject({
      superseded_by: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    });
    for (const r of after) {
      expect(r.vector.startsWith('[')).toBe(true);
      expect(r.vector.split(',').length).toBe(DIMS);
    }
    // stats report the actual insert count for the re-created collection.
    const body = res.body as { stats: Record<string, { inserted: number }> };
    expect(body.stats[COLLECTION]?.inserted).toBe(2);
  });

  // @invariant data: restore fails loudly when the archived vector dims cannot be determined
  // @fails-if an undeterminable dim silently creates a wrong-dim table or skips the restore
  it('FAILS LOUDLY when the target table is absent and the archived vector dims are undeterminable', async () => {
    const vec = Array.from({ length: DIMS }, () => 0);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, { data: 'x', user_id: 'self' });
    const good = await buildZipBytes();
    // Malformed vector: NULL — dims cannot be inferred (no element count).
    const bad = rewriteMem0Rows(good, [
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vector: null, payload: { data: 'x' } },
    ]);

    // Table absent → the create-if-absent path must infer dims; it cannot.
    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
    expect(await tableExists()).toBe(false);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes: bad });
    // Hard failure rather than silent-skip or wrong-dim table creation.
    expect(res.status).toBe(500);
    const body = res.body as { error: string };
    expect(body.error).toBe('restore_failed_mid_flight');
    // Did NOT create a wrong-dim (or any) table.
    expect(await tableExists()).toBe(false);
  });

  // @invariant data: a table-absent restore of an empty archived collection is a graceful no-op
  // @fails-if an empty archive creates a table or errors
  it('table-absent + EMPTY archived collection is a graceful no-op (no table created)', async () => {
    // Build an archive whose mem0 key is present but an EMPTY array, with the table
    // absent on the target. Nothing to restore → graceful skip, no table conjured.
    const vec = Array.from({ length: DIMS }, () => 0);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, { data: 'x', user_id: 'self' });
    const good = await buildZipBytes();
    const bytes = rewriteMem0Rows(good, []); // present but empty

    await testDb().execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
    expect(await tableExists()).toBe(false);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });
    expect(res.status).toBe(200);
    // Empty collection → no table created (mem0 self-init will make it lazily).
    expect(await tableExists()).toBe(false);
  });
});

// ─── #491 follow-up regression: EMPTY archived mem0 collection ([]) must EMPTY a
// target that HAS stale rows — present-but-empty archive ≠ "skip the collection". ──
//
// THE BUG (archive.ts:597, regression introduced by #491): the restore gate was
//   if (mem0Rows && mem0Rows.length > 0) { ... }
// so an archive carrying the mem0 key PRESENT but EMPTY ([]) — a legitimate backup of
// a DB whose collection was emptied (all memories superseded/pruned) — skipped the
// WHOLE mem0 branch (wipe + create + insert). The target kept its STALE pre-existing
// rows instead of being emptied to MATCH the archive. Restore must make the target
// collection identical to the archived one: an archived [] means "this collection is
// empty", so a target that HAS rows must be WIPED. The fix separates "should we
// process this collection at all" (archive HAS the key, even []) from "are there rows
// to insert" (only non-empty arrays insert / create-if-absent).
describe('mem0 collection empty-archive wipe', () => {
  let prevCollectionEnv: string | undefined;

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

  function rewriteMem0Rows(bytes: Uint8Array, rows: Array<Record<string, unknown>>): Uint8Array {
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      unknown
    >;
    data[COLLECTION] = rows;
    const repacked: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      repacked[name] =
        name === 'data.json' ? new TextEncoder().encode(JSON.stringify(data)) : content;
    }
    return zipSync(repacked);
  }

  // @invariant data: restoring an empty archived collection empties the target collection’s rows
  // @fails-if target rows survive an empty-archive restore
  it('EMPTIES a target collection that has rows when the archived collection is empty ([])', async () => {
    // Build an archive whose mem0 key is present but EMPTY ([]).
    const vec = Array.from({ length: DIMS }, () => 0);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, { data: 'x', user_id: 'self' });
    const good = await buildZipBytes();
    const emptyArchive = rewriteMem0Rows(good, []); // archive says: collection is empty

    // Target DB HAS stale rows the empty archive must overwrite to empty.
    await testDb().execute(sql.raw(`DELETE FROM "${COLLECTION}"`));
    await seedRow(
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      Array.from({ length: DIMS }, () => 1),
      { data: 'STALE memory that should be wiped', user_id: 'self' },
    );
    await seedRow(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      Array.from({ length: DIMS }, () => 2),
      { data: 'another STALE memory', user_id: 'self' },
    );
    expect(await readRows()).toHaveLength(2);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes: emptyArchive });
    expect(res.status).toBe(200);

    // The target collection is now EMPTY — matches the archived (empty) collection.
    // RED against the `mem0Rows.length > 0` gate, which skipped the wipe entirely.
    expect(await readRows()).toHaveLength(0);
  });
});

// ─── YUK-355 recoverability core: restore must be ATOMIC. A mid-restore failure must
// ROLL BACK — the DB must never be left half-wiped/half-restored. ──────────────────
//
// THE BUG (pre-existing): restoreFromArchive ran the FK_ORDER deletes+inserts AND the
// mem0 wipe/create/insert with NO transaction (grep: zero BEGIN/COMMIT). A failure
// part-way through left the DB half-wiped with no rollback — a real disaster-recovery
// hole for "必须可恢复" (D17 reversal). FIX: wrap the entire restore mutation sequence
// in a single drizzle db.transaction(async (tx) => { ... }); any throw rolls the whole
// thing back (Postgres supports transactional DDL, so create-extension/create-table
// inside the tx roll back too). Pre-flight validation stays BEFORE the tx.
describe('mem0/FK restore atomicity — mid-restore failure rolls back', () => {
  let prevCollectionEnv: string | undefined;

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

  async function seedKnowledgeRow(id: string, name: string) {
    await testDb().execute(sql`
      INSERT INTO knowledge (id, name, created_at, updated_at)
      VALUES (${id}, ${name}, now(), now())
    `);
  }

  async function knowledgeNames(): Promise<string[]> {
    const rows = (await testDb().execute(
      sql.raw('select name from knowledge order by name'),
    )) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // Take a real archive, then corrupt the mem0 vector to a syntactically-broken
  // pgvector text so the INSERT … ::vector cast throws DEEP inside the restore — AFTER
  // the FK_ORDER wipe has already run. Without a transaction, that half-wipes the DB.
  function corruptMem0Vector(bytes: Uint8Array): Uint8Array {
    const entries = unzipSync(bytes);
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    // 'not-a-vector' passes the id/vector/payload COLUMN allowlist (key names are fine)
    // and the shape pre-flight (it IS an array of well-shaped rows), so the failure can
    // only surface at the ::vector cast mid-transaction — exactly the half-wipe window.
    data[COLLECTION] = [
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        vector: 'not-a-vector',
        payload: { data: 'x' },
      },
    ];
    const repacked: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      repacked[name] =
        name === 'data.json' ? new TextEncoder().encode(JSON.stringify(data)) : content;
    }
    return zipSync(repacked);
  }

  // @invariant data: a mid-restore mem0 insert failure rolls back the whole FK_ORDER wipe — the canary survives
  // @fails-if the wipe commits while the restore fails
  it('rolls back the FK_ORDER wipe when the mem0 insert fails mid-restore (canary survives)', async () => {
    // Pre-existing canary in a real business table — it must survive a failed restore
    // unchanged (DB not left half-wiped). The archive's `knowledge` array does NOT
    // contain this canary (it is built from an EMPTY knowledge table below), so the
    // ONLY reason the canary still exists after the call is a successful rollback.
    await testDb().execute(sql.raw('delete from knowledge'));
    const vec = Array.from({ length: DIMS }, () => 0);
    await seedRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', vec, { data: 'x', user_id: 'self' });

    // Build the archive from the current (empty knowledge) DB, then add the canary.
    const good = await buildZipBytes();
    const bad = corruptMem0Vector(good);

    // NOW seed the canary — it is NOT in the archive, so a non-rolled-back restore
    // (FK_ORDER wipe runs, then mem0 insert throws) would leave knowledge EMPTY.
    await seedKnowledgeRow('canary-tx-1', 'CANARY survives rollback');
    expect(await knowledgeNames()).toEqual(['CANARY survives rollback']);

    const res = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes: bad });
    // The corrupt ::vector cast fails the restore.
    expect(res.status).toBe(500);
    const failBody = res.body as { error: string; message: string };
    expect(failBody.error).toBe('restore_failed_mid_flight');

    // The operator-facing MESSAGE must reflect ATOMIC rollback now that the whole
    // restore runs inside a single transaction: on failure the DB is left UNCHANGED.
    // It must NOT mislead with the stale "half-wiped state" wording, which
    // implies partial/corrupt restore that no longer happens.
    expect(failBody.message).not.toMatch(/half-wiped/i);
    expect(failBody.message).toMatch(/rolled back|unchanged|atomic/i);

    // CRITICAL: the whole mutation rolled back — the FK_ORDER wipe was undone, so the
    // canary (never in the archive) still exists. RED against the non-transactional
    // restore, where the wipe committed before the mem0 insert threw.
    expect(await knowledgeNames()).toEqual(['CANARY survives rollback']);
    // And the mem0 collection still holds its original row (its delete rolled back too).
    expect(await readRows()).toHaveLength(1);
  });
});
