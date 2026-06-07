import { createId } from '@paralleldrive/cuid2';

import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';

// Shared content-addressed image-asset write path. Extracted from
// app/api/assets/route.ts (YUK-250) so both the generic asset upload route and
// the PDF expansion route (/api/ingestion/pdf) persist `source_asset` rows
// identically:
//   - SHA-256 over the bytes → content-addressed `storage_key = assets/<sha>`
//     (re-uploading / re-rendering the same bytes yields the same key → dedup);
//   - r2.put(storageKey, bytes, mime);
//   - INSERT source_asset (kind='image', no width/height/provenance — those stay
//     defaulted/null exactly as the photo path does today).
//
// The return shape is the inserted row, so /api/assets can keep returning
// `{ asset: row }` byte-for-byte while /api/ingestion/pdf maps over many rows.

export type SourceAssetRow = typeof source_asset.$inferSelect;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
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
  return row;
}
