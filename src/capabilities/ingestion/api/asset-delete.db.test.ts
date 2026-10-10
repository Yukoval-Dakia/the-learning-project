import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { source_asset } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { DELETE } from './asset-delete';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

function deleteRequest(id: string) {
  return new Request(`http://localhost/api/assets/${id}`, { method: 'DELETE' });
}

function makeParams(id: string): Record<string, string> {
  return { id };
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

  it('keeps a shared content-addressed object until its final owner is deleted', async () => {
    const first = await seedAsset({ id: 'asset_shared_1', storage_key: 'assets/shared' });
    const second = await seedAsset({ id: 'asset_shared_2', storage_key: 'assets/shared' });
    r2._store.set('assets/shared', new Uint8Array([1, 2, 3]));

    const firstRes = await DELETE(deleteRequest(first.id), makeParams(first.id));
    expect(firstRes.status).toBe(200);
    expect(r2._store.has('assets/shared')).toBe(true);

    const db = testDb();
    expect(await db.select().from(source_asset).where(eq(source_asset.id, first.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(source_asset).where(eq(source_asset.id, second.id))).toHaveLength(
      1,
    );

    const secondRes = await DELETE(deleteRequest(second.id), makeParams(second.id));
    expect(secondRes.status).toBe(200);
    expect(r2._store.has('assets/shared')).toBe(false);
    expect(await db.select().from(source_asset).where(eq(source_asset.id, second.id))).toHaveLength(
      0,
    );
  });
});
