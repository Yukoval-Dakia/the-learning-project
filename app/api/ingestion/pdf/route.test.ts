import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { source_asset } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { POST } from './route';

// db partition — imports tests/helpers/db + memR2 (R2 mocked, but real Postgres
// for the source_asset rows). Mirrors app/api/assets/route.test.ts.
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '../../../../tests/fixtures/pdf');

function pdfFile(name: string, mime = 'application/pdf'): File {
  const buf = readFileSync(join(FIX, name));
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new File([bytes], name, { type: mime });
}

function postRequest(file: File): Request {
  const fd = new FormData();
  fd.set('file', file);
  return new Request('http://localhost/api/ingestion/pdf', { method: 'POST', body: fd });
}

describe('POST /api/ingestion/pdf', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('expands a 2-page PDF → 2 content-addressed image assets', async () => {
    const res = await POST(postRequest(pdfFile('sample-2page.pdf')));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_ids: string[]; page_count: number };
    expect(body.page_count).toBe(2);
    expect(body.asset_ids).toHaveLength(2);

    const db = testDb();
    const rows = await db
      .select()
      .from(source_asset)
      .where(inArray(source_asset.id, body.asset_ids));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe('image');
      expect(row.mime_type).toBe('image/png');
      expect(row.storage_key).toMatch(/^assets\/[0-9a-f]{64}$/);
      expect(row.byte_size).toBeGreaterThan(0);
      // The rendered PNG bytes live in (mock) R2 under the content-addressed key.
      expect(r2._store.has(row.storage_key)).toBe(true);
    }
  });

  it('is content-addressed across re-POSTs (same PDF → same storage_keys)', async () => {
    const first = (await (await POST(postRequest(pdfFile('sample-2page.pdf')))).json()) as {
      asset_ids: string[];
    };
    const db = testDb();
    const firstKeys = (
      await db
        .select({ k: source_asset.storage_key })
        .from(source_asset)
        .where(inArray(source_asset.id, first.asset_ids))
    )
      .map((r) => r.k)
      .sort();

    await resetDb();
    r2._store.clear();

    const second = (await (await POST(postRequest(pdfFile('sample-2page.pdf')))).json()) as {
      asset_ids: string[];
    };
    const secondKeys = (
      await db
        .select({ k: source_asset.storage_key })
        .from(source_asset)
        .where(inArray(source_asset.id, second.asset_ids))
    )
      .map((r) => r.k)
      .sort();

    expect(secondKeys).toEqual(firstKeys);
  });

  it('rejects a corrupt PDF → 400 validation_error', async () => {
    const res = await POST(postRequest(pdfFile('corrupt.pdf')));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/无法解析 PDF/);
  });

  it('rejects a >15-page PDF → 400 page-cap', async () => {
    const res = await POST(postRequest(pdfFile('sample-16page.pdf')));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/15 页上限/);
  });

  it('rejects a non-PDF mime → 400', async () => {
    const res = await POST(postRequest(pdfFile('sample-2page.pdf', 'image/png')));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });

  it('rejects an oversized upload → 400', async () => {
    // 30 MB + 1 byte of PDF-magic-prefixed bytes.
    const big = new Uint8Array(30_000_001);
    big.set(new TextEncoder().encode('%PDF-1.4'), 0);
    const res = await POST(postRequest(new File([big], 'big.pdf', { type: 'application/pdf' })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/上限/);
  });

  it('rejects a missing file field → 400', async () => {
    const req = new Request('http://localhost/api/ingestion/pdf', {
      method: 'POST',
      body: new FormData(),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
