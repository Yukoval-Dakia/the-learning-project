import { source_asset } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { DELETE } from './route';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

function deleteRequest(id: string) {
  return new Request(`http://localhost/api/assets/${id}`, { method: 'DELETE' });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function seedAsset(overrides: Partial<typeof source_asset.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date();
  const row = {
    id: 'asset_001',
    kind: 'image',
    storage_key: 'assets/abc123',
    mime_type: 'image/png',
    byte_size: 4,
    sha256: 'abc123',
    created_at: now,
    ...overrides,
  };
  await db.insert(source_asset).values(row);
  return row;
}

describe('DELETE /api/assets/[id]', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('returns 404 when asset does not exist', async () => {
    const res = await DELETE(deleteRequest('nonexistent'), makeParams('nonexistent'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('deletes DB row and R2 object when asset exists', async () => {
    const row = await seedAsset({ storage_key: 'assets/mykey' });
    r2._store.set('assets/mykey', new Uint8Array([1, 2, 3]));

    const res = await DELETE(deleteRequest(row.id), makeParams(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // R2 object deleted
    expect(r2._store.has('assets/mykey')).toBe(false);

    // DB row deleted
    const db = testDb();
    const rows = await db.select().from(source_asset).where(eq(source_asset.id, row.id));
    expect(rows).toHaveLength(0);
  });

  it('round-trip: POST then DELETE — row and R2 object both gone', async () => {
    // Import POST handler lazily to share same mocked r2 module
    const { POST } = await import('../route');

    const fd = new FormData();
    fd.set(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'q.png', { type: 'image/png' }),
    );
    const postRes = await POST(
      new Request('http://localhost/api/assets', { method: 'POST', body: fd }),
    );
    expect(postRes.status).toBe(201);
    const { asset } = (await postRes.json()) as { asset: { id: string; storage_key: string } };

    // R2 has it, DB has it
    expect(r2._store.has(asset.storage_key)).toBe(true);
    const db = testDb();
    const before = await db.select().from(source_asset).where(eq(source_asset.id, asset.id));
    expect(before).toHaveLength(1);

    // DELETE
    const delRes = await DELETE(deleteRequest(asset.id), makeParams(asset.id));
    expect(delRes.status).toBe(200);

    // Both gone
    expect(r2._store.has(asset.storage_key)).toBe(false);
    const after = await db.select().from(source_asset).where(eq(source_asset.id, asset.id));
    expect(after).toHaveLength(0);
  });
});
