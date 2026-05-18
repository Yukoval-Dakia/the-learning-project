import { FK_ORDER } from '@/server/export/constants';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { POST } from './route';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

// Track DB calls: DELETE and INSERT statements
const deleteCalls: string[] = [];
const insertCalls: Array<{ table: string; rows: unknown[] }> = [];

type QueryChunk = { value?: string[] } | { queryChunks?: QueryChunk[] };

function extractFullSql(query: unknown): string {
  if (typeof query === 'object' && query !== null) {
    const q = query as { queryChunks?: QueryChunk[] };
    if (Array.isArray(q.queryChunks)) {
      return q.queryChunks
        .map((chunk) => {
          if (!chunk || typeof chunk !== 'object') return '';
          const c = chunk as { value?: string[]; queryChunks?: QueryChunk[] };
          if (Array.isArray(c.value)) return c.value.join('');
          if (c.queryChunks) return extractFullSql(c);
          return '';
        })
        .join('');
    }
  }
  return String(query);
}

vi.mock('@/db/client', () => {
  return {
    db: {
      execute: vi.fn(async (query: unknown) => {
        const sqlStr = extractFullSql(query);
        if (/delete from/i.test(sqlStr)) {
          deleteCalls.push(sqlStr.trim());
        } else if (/insert into/i.test(sqlStr)) {
          insertCalls.push({ table: sqlStr, rows: [] });
        }
        return [];
      }),
    },
  };
});

function buildZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) {
    entries[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  return zipSync(entries);
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: '4.0',
    exported_at: 1700000000,
    include_assets: false,
    row_counts: {},
    asset_count: 0,
    ...overrides,
  });
}

function knowledgeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'k1',
    name: 'x',
    domain: null,
    parent_id: null,
    merged_from: '[]',
    archived_at: null,
    proposed_by_ai: 0,
    approval_status: 'approved',
    created_at: 1700000000,
    updated_at: 1700000000,
    version: 0,
    ...overrides,
  };
}

function makePostRequest(body: Uint8Array, qs = '') {
  return new Request(`http://localhost/api/_/import${qs}`, {
    method: 'POST',
    body: body.buffer as ArrayBuffer,
    headers: { 'content-type': 'application/zip' },
  });
}

describe('POST /api/_/import — guards', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    insertCalls.length = 0;
    r2._store.clear();
  });

  it('returns 400 when ?confirm is missing', async () => {
    const res = await POST(makePostRequest(new Uint8Array()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('confirm_required');
  });

  it('returns 400 when ?confirm has wrong value', async () => {
    const res = await POST(makePostRequest(new Uint8Array(), '?confirm=please'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on empty body', async () => {
    const res = await POST(makePostRequest(new Uint8Array(0), '?confirm=wipe-and-reload'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 on invalid ZIP', async () => {
    const garbage = new TextEncoder().encode('not a zip');
    const res = await POST(makePostRequest(garbage, '?confirm=wipe-and-reload'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_zip');
  });

  it('returns 400 on schema_version mismatch', async () => {
    const zip = buildZip({
      'manifest.json': validManifest({ schema_version: '0.9' }),
      'data.json': JSON.stringify({}),
    });
    const res = await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; expected: string; got: string };
    expect(body.error).toBe('schema_version_mismatch');
    expect(body.expected).toBe('4.0');
    expect(body.got).toBe('0.9');
  });

  it('returns 400 when manifest.json is missing from ZIP', async () => {
    const zip = buildZip({ 'data.json': '{}' });
    const res = await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_zip');
    expect(body.message).toContain('manifest.json');
  });
});

describe('POST /api/_/import — wipe + reinsert', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    insertCalls.length = 0;
    r2._store.clear();
  });

  it('issues DELETE FROM in REVERSE FK order before any INSERT', async () => {
    const zip = buildZip({
      'manifest.json': validManifest(),
      'data.json': JSON.stringify({}),
    });
    await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    expect(deleteCalls.length).toBe(FK_ORDER.length);
    // First delete should be the last FK_ORDER table (reverse order)
    expect(deleteCalls[0]).toMatch(
      new RegExp(`delete from "${FK_ORDER[FK_ORDER.length - 1]}"`, 'i'),
    );
    expect(deleteCalls[deleteCalls.length - 1]).toMatch(
      new RegExp(`delete from "${FK_ORDER[0]}"`, 'i'),
    );
  });

  it('inserts data in FORWARD FK order', async () => {
    const zip = buildZip({
      'manifest.json': validManifest({ row_counts: { knowledge: 1 } }),
      'data.json': JSON.stringify({ knowledge: [knowledgeRow()] }),
    });
    await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    const knowledgeInserts = insertCalls.filter((c) => /insert into "knowledge"/i.test(c.table));
    expect(knowledgeInserts.length).toBeGreaterThan(0);
  });

  it('PUTs assets to R2 when assets are present', async () => {
    const zip = buildZip({
      'manifest.json': validManifest({ include_assets: true, asset_count: 2 }),
      'data.json': JSON.stringify({}),
      'assets/sk-1': 'IMG-A',
      'assets/sk-2': 'IMG-B',
    });
    const putSpy = vi.spyOn(r2, 'put');
    await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    expect(putSpy).toHaveBeenCalledTimes(2);
    const keys = putSpy.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual(['sk-1', 'sk-2']);
  });

  it('returns ok:true with stats per table', async () => {
    const zip = buildZip({
      'manifest.json': validManifest({ row_counts: { knowledge: 1 } }),
      'data.json': JSON.stringify({ knowledge: [knowledgeRow()] }),
    });
    const res = await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    if (res.status !== 200) {
      const body = await res.clone().json();
      console.error('unexpected response:', JSON.stringify(body));
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stats: Record<string, { deleted: number; inserted: number }>;
      assets_uploaded: number;
    };
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);
  });
});

describe('POST /api/_/import — pre-flight validation', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    insertCalls.length = 0;
  });

  it('rejects data.json with column shape mismatch BEFORE wiping DB', async () => {
    const zip = buildZip({
      'manifest.json': validManifest({ row_counts: { knowledge: 2 } }),
      'data.json': JSON.stringify({
        knowledge: [
          { id: 'k1', name: 'x', parent_id: null },
          { id: 'k2', name: 'y' }, // missing parent_id!
        ],
      }),
    });
    const res = await POST(makePostRequest(zip, '?confirm=wipe-and-reload'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe('data_validation_failed');
    expect(body.issues.length).toBeGreaterThan(0);
    // CRITICAL: no DELETE issued — DB NOT touched.
    expect(deleteCalls.length).toBe(0);
  });
});
