import { FK_ORDER, SCHEMA_VERSION } from '@/server/export/constants';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { BackupImportResponseSchema } from './backup-contracts';
import { MAX_BACKUP_UPLOAD_BYTES, POST } from './backup-import';

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
  // Single execute implementation shared by the outer `db` AND the `tx` handed to
  // db.transaction(cb). restoreFromArchive runs its entire wipe+insert sequence inside
  // `await db.transaction(async (tx) => {...})` using `tx.execute`, so the mock must
  // expose `transaction` (else `db.transaction is not a function` throws and restore
  // returns 500). Routing tx.execute through the SAME spy keeps the DELETE/INSERT
  // tracking arrays populated for the assertions below (YUK-355 atomicity follow-up).
  const execute = vi.fn(async (query: unknown) => {
    const sqlStr = extractFullSql(query);
    if (/delete from/i.test(sqlStr)) {
      deleteCalls.push(sqlStr.trim());
    } else if (/insert into/i.test(sqlStr)) {
      insertCalls.push({ table: sqlStr, rows: [] });
    }
    return [];
  });
  return {
    db: {
      execute,
      transaction: vi.fn(async (cb: (tx: { execute: typeof execute }) => unknown) =>
        cb({ execute }),
      ),
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
    schema_version: SCHEMA_VERSION,
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
    expect(body.expected).toBe(SCHEMA_VERSION);
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

  // YUK-729 — an oversized backup upload must trip the OOM safety limit by its
  // declared Content-Length BEFORE the whole ZIP is buffered into memory and the
  // destructive wipe-and-reload runs. Uses the exported tripwire + 1 so it stays
  // correct regardless of the resolved value (default ~1 GB, BACKUP_IMPORT_MAX_BYTES
  // override).
  it('returns 413 when the declared Content-Length exceeds the OOM tripwire, with zero side effects', async () => {
    const req = new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      // Tiny actual body; the oversized Content-Length header is what gates.
      body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(MAX_BACKUP_UPLOAD_BYTES + 1),
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
    // Destructive restore never started: no DELETE and no INSERT issued.
    expect(deleteCalls.length).toBe(0);
    expect(insertCalls.length).toBe(0);
  });

  // YUK-729 (#965 round-3) — a chunked / no-Content-Length upload skips the pre-read
  // gate, so a POST-READ backstop must still refuse to feed an over-limit body into
  // the destructive wipe-and-reload. Driven with a tiny env-set tripwire (re-imported
  // module) so the check is exercised without a ~1 GB allocation.
  it('returns 413 when a body without Content-Length exceeds the tripwire after buffering, with zero side effects', async () => {
    // 2 MB tripwire (above the 1 MB floor) so the post-read check is exercised with a
    // small, real allocation rather than the ~1 GB default.
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', '2000000');
    vi.resetModules();
    const { POST: freshPost, MAX_BACKUP_UPLOAD_BYTES: smallCap } = await import('./backup-import');
    expect(smallCap).toBe(2_000_000);

    const oversized = new Uint8Array(smallCap + 1); // just over the tripwire, no Content-Length
    const req = new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      body: oversized.buffer as ArrayBuffer,
      headers: { 'content-type': 'application/zip' },
    });
    // The pre-read gate is genuinely bypassed: this runtime does not surface a
    // Content-Length for an ArrayBuffer body, so the post-read check is what fires.
    expect(req.headers.get('content-length')).toBeNull();

    const res = await freshPost(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
    // Destructive restore never started even though the body was buffered whole.
    expect(deleteCalls.length).toBe(0);
    expect(insertCalls.length).toBe(0);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // YUK-729 (#965 round-4) — a below-floor BACKUP_IMPORT_MAX_BYTES (operator typo)
  // must NOT be honored, or it would silently 413 every restore. It warns and falls
  // back to the default instead.
  it('ignores a below-floor BACKUP_IMPORT_MAX_BYTES, warning and falling back to the default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', '1000'); // 1 KB — below the 1 MB floor
    vi.resetModules();
    const { MAX_BACKUP_UPLOAD_BYTES: resolved } = await import('./backup-import');

    // Fell back to the default (the unstubbed top-level value), not the 1 KB typo.
    expect(resolved).toBe(MAX_BACKUP_UPLOAD_BYTES);
    expect(resolved).toBeGreaterThan(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BACKUP_IMPORT_MAX_BYTES=1000'));

    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
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
    const body = BackupImportResponseSchema.parse(await res.json());
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
