import { createHash } from 'node:crypto';

import type { Db } from '@/db/client';
import type { R2Client } from '@/server/r2';
import { describe, expect, it, vi } from 'vitest';

import { persistImageAsset, sha256Hex } from './persist-image-asset';

// Pure unit (no DB/R2): sha256Hex only touches crypto.subtle. Lives in the unit
// partition (enumerated in vitest.shared.ts fastTestInclude). The DB-backed
// persistImageAsset row write is covered by src/capabilities/ingestion/api/pdf.db.test.ts
// + src/capabilities/ingestion/api/assets.db.test.ts (db partition).

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('sha256Hex', () => {
  it('hashes a plain full-buffer Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await sha256Hex(bytes)).toBe(nodeSha256Hex(bytes));
  });

  // Regression (YUK-250 bot-review F1): PDF page PNGs arrive as a VIEW into a
  // larger pooled ArrayBuffer with a non-zero byteOffset / partial byteLength
  // (sharp().toBuffer() Node Buffer → new Uint8Array(buf.buffer, byteOffset,
  // byteLength)). Hashing `bytes.buffer` would digest the whole pool and diverge
  // from the byte_size + r2.put bytes, breaking content addressing. sha256Hex
  // must hash exactly the view's bytes.
  it('respects byteOffset/byteLength of a window into a larger ArrayBuffer', async () => {
    const payload = new Uint8Array([10, 20, 30, 40]);

    // Embed `payload` at a non-zero offset inside a bigger backing buffer, with
    // different bytes on either side (as a pooled allocation would have).
    const backing = new Uint8Array(16);
    backing.set([99, 99, 99], 0); // junk before
    const offset = 3;
    backing.set(payload, offset);
    backing.set([88, 88, 88, 88, 88], offset + payload.length); // junk after

    const view = new Uint8Array(backing.buffer, offset, payload.length);

    // The view must hash to the standalone payload — NOT to the whole backing
    // buffer (which the old `bytes.buffer` path would have produced).
    expect(await sha256Hex(view)).toBe(nodeSha256Hex(payload));
    expect(await sha256Hex(view)).not.toBe(nodeSha256Hex(backing));
  });

  it('is deterministic — same bytes yield the same key', async () => {
    const a = new Uint8Array([7, 7, 7]);
    const b = new Uint8Array([7, 7, 7]);
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });
});

describe('persistImageAsset compensation', () => {
  function failingDb(existingOwners: Array<{ id: string }>): Db {
    return {
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new Error('injected source_asset insert failure');
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => existingOwners }),
        }),
      }),
    } as unknown as Db;
  }

  function r2Spy(): R2Client & { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
    return {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    };
  }

  it('deletes a just-written R2 object when source_asset INSERT fails with no owner', async () => {
    const r2 = r2Spy();
    await expect(
      persistImageAsset(failingDb([]), r2, {
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        compensatePutOnInsertFailure: true,
      }),
    ).rejects.toThrow('injected source_asset insert failure');

    expect(r2.put).toHaveBeenCalledOnce();
    expect(r2.delete).toHaveBeenCalledWith(expect.stringMatching(/^assets\/[0-9a-f]{64}$/));
  });

  it('keeps a content-addressed object when another source_asset row owns the key', async () => {
    const r2 = r2Spy();
    await expect(
      persistImageAsset(failingDb([{ id: 'shared-owner' }]), r2, {
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        compensatePutOnInsertFailure: true,
      }),
    ).rejects.toThrow('injected source_asset insert failure');

    expect(r2.delete).not.toHaveBeenCalled();
  });
});
