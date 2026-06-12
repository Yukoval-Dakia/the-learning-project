/**
 * Security regression (YUK-136): archive restore must validate every column name
 * against the schema-derived allowlist BEFORE the destructive wipe.
 *
 * restoreFromArchive builds its INSERT column list from Object.keys(rows[0]) —
 * attacker-controlled, straight out of the uploaded ZIP's data.json — and
 * interpolates it via raw SQL. Without a column-name allowlist that is a raw-SQL
 * injection surface, and the wipe (`delete from …`) runs before the bad INSERT
 * fails, destroying data.
 *
 * These tests prove:
 *   1. A malicious / unknown column for some table → 400 invalid_column AND the
 *      pre-seeded row STILL EXISTS (no wipe happened).
 *   2. An unknown top-level table key → 400 invalid_table AND no wipe.
 *   3. A valid round-trip restore still succeeds (allowlist does not break the
 *      happy path).
 *
 * Real Postgres (testcontainer) → DB partition. Mirrors _round_trip.test.ts.
 */
import { knowledge } from '@/db/schema';
import { SCHEMA_VERSION } from '@/server/export/constants';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { GET } from './backup-export';
import { POST } from './backup-import';

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

const enc = new TextEncoder();

/** Build a minimal valid ZIP archive from a data.json object. */
function makeArchive(data: Record<string, unknown[]>): Uint8Array {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: Math.floor(Date.now() / 1000),
    include_assets: false,
    row_counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    asset_count: 0,
    missing_assets: [],
  };
  return zipSync({
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'data.json': enc.encode(JSON.stringify(data)),
  });
}

function importRequest(body: Uint8Array): Request {
  // Copy into a fresh ArrayBuffer-backed view so the body is an unambiguous
  // BodyInit (fflate's zipSync returns Uint8Array<ArrayBufferLike>).
  return new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
    method: 'POST',
    body: new Uint8Array(body),
    headers: { 'content-type': 'application/zip' },
  });
}

describe('restore column allowlist (YUK-136) — wipe is gated on schema validation', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('rejects an unknown column with 400 invalid_column AND does NOT wipe the DB', async () => {
    const db = testDb();
    const now = new Date('2024-01-01T00:00:00Z');

    // Seed a sentinel row that MUST survive a rejected restore.
    await db.insert(knowledge).values({
      id: 'sentinel',
      name: '不能被删',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Malicious archive: a real table, but an unknown column name injected into
    // the row. This is the raw-SQL injection vector the allowlist must block.
    const archive = makeArchive({
      knowledge: [
        {
          id: 'attacker',
          name: 'x',
          'evil") ; drop table knowledge; --': 'boom',
        },
      ],
    });

    const res = await POST(importRequest(archive));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; table?: string; column?: string };
    expect(body.error).toBe('invalid_column');
    expect(body.table).toBe('knowledge');
    expect(body.column).toBe('evil") ; drop table knowledge; --');

    // The wipe must NOT have run: sentinel row still present, attacker row absent.
    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sentinel');
  });

  it('rejects an unknown top-level table key with 400 invalid_table AND does NOT wipe the DB', async () => {
    const db = testDb();
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id: 'sentinel2',
      name: '也不能被删',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const archive = makeArchive({
      not_a_real_table: [{ id: 'x' }],
    });

    const res = await POST(importRequest(archive));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; table?: string };
    expect(body.error).toBe('invalid_table');
    expect(body.table).toBe('not_a_real_table');

    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sentinel2');
  });

  it('still performs a valid round-trip restore (allowlist does not break the happy path)', async () => {
    const db = testDb();
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Export the real DB (only valid columns), wipe, then restore.
    const exportRes = await GET(new Request('http://localhost/api/_/export'));
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();

    await resetDb();
    expect(await db.select().from(knowledge)).toHaveLength(0);

    const res = await POST(importRequest(new Uint8Array(ab)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stats: Record<string, { inserted: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);

    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('k1');
    expect(rows[0].name).toBe('虚词');
  });
});
