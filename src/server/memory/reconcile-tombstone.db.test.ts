// YUK-557 (Q2a / Lens B M4) — real-Memory tombstone integration test.
//
// Proves the load-bearing Q2a guarantee: mem0's OFFICIAL delete() writes the
// deleted memory's text into the SQLite memory_history tombstone (action='DELETE',
// previous_value=<text>, is_deleted=1) BEFORE the real vector DELETE — the free
// 副保底 that makes MERGE/RETRACT_NEW hard-deletes recoverable. A pure mock cannot
// prove this; only a real `new Memory(config)` + `memory.delete(id)` can.
//
// Hermeticity (owner CI decision, spec appendix §5): the delete path does NOT
// embed (it reads the existing row, deletes it, writes history), and the embed
// dimension probe is skipped by setting vectorStore.config.dimension explicitly —
// so no embedder/LLM network call is made. If `new Memory(config)` still cannot
// initialize hermetically in this environment (e.g. the pg maintenance-db connect
// or the native better-sqlite3 module is unavailable), the suite SKIPS at runtime
// with an explicit logged reason (YUK-501-style) rather than failing — the test
// body is still authored and runs wherever the environment supports it.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Memory, type MemoryConfig } from 'mem0ai/oss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

// better-sqlite3 ships no bundled types and @types/better-sqlite3 is not a project
// dep. Load it via require and type only the sliver this test uses (the same
// createRequire pattern the native-parity tests use for their addon).
type SqliteStatement = { all(...params: unknown[]): unknown[] };
type SqliteDatabase = { prepare(source: string): SqliteStatement; close(): void };
type SqliteCtor = new (path: string, opts?: { readonly?: boolean }) => SqliteDatabase;
const Database = createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;

const DIMS = 8;
const COLLECTION = 'test_tombstone_collection';

type TombstoneRow = {
  memory_id: string;
  previous_value: string | null;
  new_value: string | null;
  action: string;
  is_deleted: number;
};

function pgConnFromTestUrl(): {
  dbname: string;
  user: string;
  password: string;
  host: string;
  port: number;
} {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL/DATABASE_URL not set — globalSetup did not run');
  const url = new URL(raw);
  return {
    dbname: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
  };
}

let tmpDir: string | undefined;
let historyDbPath: string | undefined;
let memory: Memory | undefined;
let skipReason: string | undefined;

beforeAll(async () => {
  // Telemetry off (spec §8.6): _captureEvent must not attempt a network POST.
  process.env.MEM0_TELEMETRY = 'false';
  const conn = pgConnFromTestUrl();
  tmpDir = mkdtempSync(join(tmpdir(), 'yuk557-tombstone-'));
  historyDbPath = join(tmpDir, 'history.db');

  // dimension set explicitly → mem0 skips the embed-dimension probe (no network);
  // embeddingModelDims sizes the collection's vector column.
  const config = {
    embedder: {
      provider: 'openai',
      config: {
        apiKey: 'test',
        model: 'unused',
        baseURL: 'http://127.0.0.1:9',
        embeddingDims: DIMS,
      },
    },
    vectorStore: {
      provider: 'pgvector',
      config: {
        collectionName: COLLECTION,
        dbname: conn.dbname,
        user: conn.user,
        password: conn.password,
        host: conn.host,
        port: conn.port,
        embeddingModelDims: DIMS,
        dimension: DIMS,
      },
    },
    llm: {
      provider: 'openai',
      config: { apiKey: 'test', model: 'unused', baseURL: 'http://127.0.0.1:9' },
    },
    disableHistory: false,
    historyDbPath,
  } as unknown as MemoryConfig;

  try {
    const m = new Memory(config);
    // history() triggers _ensureInitialized() → _autoInitialize() (vectorStore +
    // collection table). Awaiting it guarantees the collection exists before the
    // manual INSERT below, and surfaces any init failure here (→ skip).
    await m.history('00000000-0000-0000-0000-000000000000');
    memory = m;
  } catch (err) {
    skipReason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[YUK-557] real-Memory tombstone integration SKIPPED — new Memory(config) could not initialize hermetically: ${skipReason}`,
    );
  }
});

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('mem0 official delete() writes a memory_history tombstone (Q2a)', () => {
  it('DELETE row carries previous_value=<text> and is_deleted=1 (recoverable delete)', async (ctx) => {
    if (!memory || !historyDbPath) {
      ctx.skip();
      return;
    }
    const db = testDb();
    await resetDb();
    // Recreate the collection row-space clean (resetDb does not touch this
    // mem0-managed table). The table itself was created by Memory init above.
    await db.execute(sql.raw(`DELETE FROM "${COLLECTION}"`));

    const memId = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const text = 'User prefers dark mode and terse feedback';
    const zeroVec = `[${Array(DIMS).fill(0).join(',')}]`;
    // Manual pgvector INSERT (the delete path does NOT embed, so a zero vector is
    // fine — mem0's deleteMemory reads payload.data, deletes, and writes history).
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, vector, payload)
      VALUES (${memId}::uuid, ${zeroVec}::vector, ${JSON.stringify({ data: text, user_id: 'self' })}::jsonb)
    `);

    await memory.delete(memId);

    // Vector row is physically gone.
    const remaining = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${memId}::uuid`,
    )) as unknown[];
    expect(remaining).toHaveLength(0);

    // The SQLite memory_history tombstone holds the recoverable text.
    const sqlite = new Database(historyDbPath, { readonly: true });
    try {
      const rows = sqlite
        .prepare(
          "SELECT memory_id, previous_value, new_value, action, is_deleted FROM memory_history WHERE memory_id = ? AND action = 'DELETE' ORDER BY id DESC",
        )
        .all(memId) as TombstoneRow[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].action).toBe('DELETE');
      expect(rows[0].previous_value).toBe(text);
      expect(rows[0].new_value).toBeNull();
      expect(rows[0].is_deleted).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
