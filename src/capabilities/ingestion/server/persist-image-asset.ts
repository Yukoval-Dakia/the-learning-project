import { createId } from '@paralleldrive/cuid2';

import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';

// Shared content-addressed image-asset write path. Extracted from
// app/api/assets/route.ts (YUK-250) so both the generic asset upload route and
// the PDF expansion route (/api/ingestion/pdf) persist `source_asset` rows
// identically:
//   - SHA-256 over the bytes → content-addressed `storage_key = assets/<sha>`.
//     Dedup is at the R2 object layer only: re-uploading / re-rendering the same
//     bytes yields the same storage_key, so r2.put overwrites the same object
//     (no orphan grows). The DB row is NOT deduped — each call createId()s a new
//     source_asset row (sha256/storage_key carry no unique constraint), so the
//     same bytes can back multiple rows. That is intentional: an asset id is the
//     handle a session pins, and two sessions may legitimately reference the
//     identical page bytes via distinct rows.
//   - r2.put(storageKey, bytes, mime);
//   - INSERT source_asset (kind='image', no width/height/provenance — those stay
//     defaulted/null exactly as the photo path does today).
//
// The return shape is the inserted row, so /api/assets can keep returning
// `{ asset: row }` byte-for-byte while /api/ingestion/pdf maps over many rows.

export type SourceAssetRow = typeof source_asset.$inferSelect;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Hash the VIEW's bytes, not `bytes.buffer`. A Uint8Array can be a window into
  // a larger (pooled) ArrayBuffer with a non-zero byteOffset / partial byteLength
  // — e.g. PDF page PNGs from pdf-render.ts are sharp().toBuffer() Node Buffers
  // wrapped as `new Uint8Array(png.buffer, png.byteOffset, png.byteLength)`.
  // Passing `bytes.buffer` would hash the whole underlying pool, diverging from
  // the byte_size + r2.put bytes (which use the view) and breaking content
  // addressing / dedup. `.slice()` copies exactly the view's bytes into a fresh,
  // non-shared ArrayBuffer (honouring offset/length), giving digest() a clean
  // BufferSource.
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function persistImageAsset(
  db: Db,
  r2: R2Client,
  input: { bytes: Uint8Array; mime: string },
): Promise<SourceAssetRow> {
  const { bytes, mime } = input;
  const sha = await sha256Hex(bytes);
  const storageKey = `assets/${sha}`;
  await r2.put(storageKey, bytes, mime);

  const id = createId();
  const now = new Date();
  const [row] = await db
    .insert(source_asset)
    .values({
      id,
      kind: 'image',
      storage_key: storageKey,
      mime_type: mime,
      byte_size: bytes.byteLength,
      sha256: sha,
      created_at: now,
    })
    .returning();
  // INSERT ... RETURNING always yields the inserted row, but guard the empty-array
  // case so the Promise<SourceAssetRow> contract can never resolve to undefined.
  if (!row) {
    throw new Error('persistImageAsset: INSERT ... RETURNING returned no row');
  }
  return row;
}
