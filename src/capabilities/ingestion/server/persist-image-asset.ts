import { createId } from '@paralleldrive/cuid2';

import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';
import { and, eq, ne, sql } from 'drizzle-orm';

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

/** Serialize every put/owner mutation for one content-addressed object. */
export async function lockImageStorageKey(tx: Tx, storageKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${storageKey}, 0))`);
}

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
  input: {
    bytes: Uint8Array;
    mime: string;
    provenance?: typeof source_asset.$inferInsert.provenance;
    compensatePutOnInsertFailure?: boolean;
  },
): Promise<SourceAssetRow> {
  const { bytes, mime } = input;
  const sha = await sha256Hex(bytes);
  const storageKey = `assets/${sha}`;

  const id = createId();
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    // The key is shared across source_asset rows. Hold one DB advisory lock from before put
    // through owner-row commit, closing the unsafe "put complete, owner not visible" window.
    await lockImageStorageKey(tx, storageKey);
    const hadOwnerBeforePut = input.compensatePutOnInsertFailure
      ? (
          await tx
            .select({ id: source_asset.id })
            .from(source_asset)
            .where(eq(source_asset.storage_key, storageKey))
            .limit(1)
        ).length > 0
      : true;
    await r2.put(storageKey, bytes, mime);
    try {
      const [inserted] = await tx
        .insert(source_asset)
        .values({
          id,
          kind: 'image',
          storage_key: storageKey,
          mime_type: mime,
          byte_size: bytes.byteLength,
          sha256: sha,
          provenance: input.provenance,
          created_at: now,
        })
        .returning();
      return inserted;
    } catch (err) {
      if (input.compensatePutOnInsertFailure && !hadOwnerBeforePut) {
        try {
          // The transaction may already be aborted by the failed INSERT, so use the owner
          // snapshot taken while holding the key lock instead of issuing another SQL query.
          await r2.delete(storageKey);
        } catch (cleanupErr) {
          console.error('[persistImageAsset] failed to compensate R2 put:', cleanupErr);
        }
      }
      throw err;
    }
  });
  // INSERT ... RETURNING always yields the inserted row, but guard the empty-array
  // case so the Promise<SourceAssetRow> contract can never resolve to undefined.
  if (!row) {
    throw new Error('persistImageAsset: INSERT ... RETURNING returned no row');
  }
  return row;
}

/**
 * Delete one logical owner and remove the content-addressed object only after its final owner.
 * Every `assets/<sha>` owner mutation shares the same advisory-lock protocol as writes.
 */
export async function deleteImageAsset(db: Db, r2: R2Client, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .select({ id: source_asset.id, storageKey: source_asset.storage_key })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!snapshot) return false;

    await lockImageStorageKey(tx, snapshot.storageKey);

    // The target may have disappeared while this transaction waited for a concurrent
    // mutation of the same storage key. Re-read it under the key lock before acting.
    const [live] = await tx
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!live) return false;

    const [otherOwner] = await tx
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(and(eq(source_asset.storage_key, snapshot.storageKey), ne(source_asset.id, id)))
      .limit(1);

    if (!otherOwner) {
      await r2.delete(snapshot.storageKey);
    }
    await tx.delete(source_asset).where(eq(source_asset.id, id));
    return true;
  });
}
