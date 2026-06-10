import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from './persist-image-asset';

// Pure unit (no DB/R2): sha256Hex only touches crypto.subtle. Lives in the unit
// partition (enumerated in vitest.shared.ts fastTestInclude). The DB-backed
// persistImageAsset row write is covered by app/api/ingestion/pdf/route.test.ts
// + app/api/assets/route.test.ts (db partition).

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
