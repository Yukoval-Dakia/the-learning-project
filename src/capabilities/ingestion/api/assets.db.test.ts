import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistImageAsset } from '@/capabilities/ingestion/server/persist-image-asset';
import { source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

describe('POST /api/assets', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('serializes concurrent puts for one content-addressed storage key', async () => {
    const db = testDb();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    let activePuts = 0;
    let maxActivePuts = 0;
    const lockingR2: R2Client = {
      get: r2.get,
      delete: r2.delete,
      put: async (key, body, mime) => {
        activePuts += 1;
        maxActivePuts = Math.max(maxActivePuts, activePuts);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await r2.put(key, body, mime);
        activePuts -= 1;
      },
    };

    const [first, second] = await Promise.all([
      persistImageAsset(db, lockingR2, { bytes, mime: 'image/png' }),
      persistImageAsset(db, lockingR2, { bytes, mime: 'image/png' }),
    ]);

    expect(first.storage_key).toBe(second.storage_key);
    expect(maxActivePuts).toBe(1);
    expect(await db.select().from(source_asset)).toHaveLength(2);
  });
});
