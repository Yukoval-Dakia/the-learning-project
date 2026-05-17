// Phase 1c.2.C — GET /api/assets/[id]/content streams R2 bytes for the UI.

import { source_asset } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

// Stub R2 BEFORE importing the route (the route resolves getR2 at module load
// time via a singleton, but the singleton itself is lazy — first call wins).
const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
const r2Store = new Map<string, Uint8Array>();
vi.mock('@/server/r2', () => ({
  getR2: () => ({
    put: async (key: string, body: Uint8Array) => {
      r2Store.set(key, body);
    },
    get: async (key: string) => r2Store.get(key) ?? null,
    delete: async (key: string) => {
      r2Store.delete(key);
    },
  }),
}));

const { GET } = await import('./route');

async function seedAsset(
  id: string,
  opts: { storage_key: string; mime: string; bytes: Uint8Array },
) {
  const db = testDb();
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: opts.storage_key,
    mime_type: opts.mime,
    byte_size: opts.bytes.byteLength,
    sha256: 'fake-sha',
    created_at: new Date(),
  });
  r2Store.set(opts.storage_key, opts.bytes);
}

async function fetchContent(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/assets/${id}/content`, { method: 'GET' }), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/assets/[id]/content', () => {
  beforeEach(async () => {
    await resetDb();
    r2Store.clear();
  });

  it('streams the asset bytes with the correct mime type', async () => {
    await seedAsset('asset_a', { storage_key: 'assets/a', mime: 'image/png', bytes: fakeBytes });

    const res = await fetchContent('asset_a');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(fakeBytes.byteLength));
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out).toEqual(fakeBytes);
  });

  it('404s when the asset id does not exist', async () => {
    const res = await fetchContent('missing');
    expect(res.status).toBe(404);
  });

  it('404s when DB row exists but R2 has no bytes', async () => {
    const db = testDb();
    await db.insert(source_asset).values({
      id: 'orphan',
      kind: 'image',
      storage_key: 'assets/orphan',
      mime_type: 'image/jpeg',
      byte_size: 0,
      sha256: 'fake',
      created_at: new Date(),
    });
    // intentionally do NOT put bytes in r2Store
    const res = await fetchContent('orphan');
    expect(res.status).toBe(404);
  });
});
