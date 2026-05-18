import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { GET } from './route';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

// Mock db client — we do NOT want to spin up a real DB for these unit tests.
// We intercept `sql.raw` queries executed by buildBackupArchive.
// The mock captures `select * from <table>` calls and returns fixture data.
const tableMock: Record<string, unknown[]> = {};
function extractSql(query: unknown): string {
  if (typeof query === 'object' && query !== null) {
    // drizzle sql.raw() object: { queryChunks: [{ value: [string] }] }
    const q = query as { queryChunks?: Array<{ value: string[] }> };
    if (q.queryChunks?.[0]?.value?.[0]) return q.queryChunks[0].value[0];
  }
  return String(query);
}

vi.mock('@/db/client', () => {
  return {
    db: {
      execute: vi.fn(async (query: unknown) => {
        const sqlStr = extractSql(query);
        const m = sqlStr.match(/from\s+"?(\w+)"?/i);
        const t = m?.[1] ?? '';
        return tableMock[t] ?? [];
      }),
    },
  };
});

function makeGetRequest(qs = '') {
  return new Request(`http://localhost/api/_/export${qs}`);
}

describe('GET /api/_/export — refs only', () => {
  beforeEach(() => {
    for (const k of Object.keys(tableMock)) delete tableMock[k];
    r2._store.clear();
  });

  it('returns 200 application/zip with content-disposition', async () => {
    tableMock.knowledge = [{ id: 'k1', name: '虚词', parent_id: null }];
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="loom-backup-\d{4}-\d{2}-\d{2}\.zip"/,
    );
  });

  it('ZIP contains manifest.json + data.json + 2 csv + README.md', async () => {
    tableMock.knowledge = [{ id: 'k1', name: 'x', parent_id: null }];
    const res = await GET(makeGetRequest());
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(Object.keys(entries).sort()).toEqual([
      'README.md',
      'data.json',
      'manifest.json',
      'mistakes.csv',
      'review_events.csv',
    ]);
  });

  it('manifest.json has correct schema_version and row_counts', async () => {
    tableMock.knowledge = [
      { id: 'k1', name: 'x', parent_id: null },
      { id: 'k2', name: 'y', parent_id: null },
    ];
    tableMock.event = [
      {
        id: 'e1',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        outcome: 'failure',
        payload: '{"answer_md":"x","answer_image_refs":[],"referenced_knowledge_ids":[]}',
      },
    ];
    const res = await GET(makeGetRequest());
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.schema_version).toBe('4.0');
    expect(manifest.include_assets).toBe(false);
    expect(manifest.row_counts.knowledge).toBe(2);
    expect(manifest.row_counts.event).toBe(1);
    expect(manifest.row_counts.learning_record).toBe(0);
    expect(manifest.row_counts.memory_brief_note).toBe(0);
    expect(manifest.asset_count).toBe(0);
  });

  it('does NOT call r2.get when include_assets is absent', async () => {
    tableMock.source_asset = [{ id: 'a1', storage_key: 'sk1' }];
    const getSpy = vi.spyOn(r2, 'get');
    await GET(makeGetRequest());
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/_/export?include_assets=1', () => {
  beforeEach(() => {
    for (const k of Object.keys(tableMock)) delete tableMock[k];
    r2._store.clear();
  });

  it('includes assets/ entries with R2 bytes', async () => {
    tableMock.source_asset = [
      { id: 'a1', storage_key: 'sk-1' },
      { id: 'a2', storage_key: 'sk-2' },
    ];
    r2._store.set('sk-1', new TextEncoder().encode('PNG-A'));
    r2._store.set('sk-2', new TextEncoder().encode('PNG-B'));
    const res = await GET(makeGetRequest('?include_assets=1'));
    expect(res.status).toBe(200);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['assets/sk-1']).toBeDefined();
    expect(entries['assets/sk-2']).toBeDefined();
    expect(new TextDecoder().decode(entries['assets/sk-1'])).toBe('PNG-A');
  });

  it('skips assets whose R2 object is missing AND records key in manifest.missing_assets', async () => {
    tableMock.source_asset = [
      { id: 'a1', storage_key: 'sk-present' },
      { id: 'a2', storage_key: 'sk-missing' },
    ];
    r2._store.set('sk-present', new TextEncoder().encode('X'));
    const res = await GET(makeGetRequest('?include_assets=1'));
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['assets/sk-present']).toBeDefined();
    expect(entries['assets/sk-missing']).toBeUndefined();
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.missing_assets).toContain('sk-missing');
    expect(manifest.asset_count).toBe(1);
  });

  it('returns 400 too_many_assets when source_asset > MAX_INLINE_ASSETS', async () => {
    tableMock.source_asset = Array.from({ length: 46 }, (_, i) => ({
      id: `a${i}`,
      storage_key: `sk-${i}`,
    }));
    const res = await GET(makeGetRequest('?include_assets=1'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; count: number; limit: number };
    expect(body.error).toBe('too_many_assets');
    expect(body.count).toBe(46);
    expect(body.limit).toBe(45);
  });
});
