import { createId } from '@paralleldrive/cuid2';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';

// Shared content-addressed asset write path. Dedup happens only at the object
// layer (`storage_key = assets/<sha>`); each call still inserts a distinct
// source_asset row because an asset id is the handle a session pins. kind and
// provenance stay caller-supplied; this module owns the storage/lock mechanism.

/** Blob handle this protocol needs. `R2Client` satisfies it structurally; kernel
 * cannot import the server seam, and the protocol never reads objects back. */
export interface AssetBlobClient {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SourceAssetRow = typeof source_asset.$inferSelect;

/** Serialize every put/owner mutation for one content-addressed object. */
export async function lockImageStorageKey(tx: Tx, storageKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${storageKey}, 0))`);
}

/** postgres.js may wrap unique violations; walk the cause chain for code 23505. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Hash the view's bytes, not `bytes.buffer`: a Uint8Array may be a window into
  // a larger pooled buffer. slice() copies exactly the view into a clean BufferSource.
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function imageDimensions(bytes: Uint8Array) {
  try {
    // Migration/CLI bundles also import this module; load sharp only when needed.
    const { default: sharp } = await import('sharp');
    return await sharp(Buffer.from(bytes)).metadata();
  } catch {
    return null;
  }
}

// Non-image source-package artifacts use the same protocol; kind marks the role.
// id/storageKey overrides support deterministic row identities such as figure crops.
export async function persistSourceAsset(
  db: Db,
  r2: AssetBlobClient,
  input: {
    bytes: Uint8Array;
    mime: string;
    kind: 'image' | 'pdf' | 'text' | 'docx';
    id?: string;
    storageKey?: string;
    provenance?: typeof source_asset.$inferInsert.provenance;
    compensatePutOnInsertFailure?: boolean;
  },
): Promise<SourceAssetRow> {
  const { bytes, mime } = input;
  // Metadata read does not hold the DB/storage-key lock; unsupported inputs keep
  // unknown dimensions rather than a synthesized size.
  const dimensions = input.kind === 'image' ? await imageDimensions(bytes) : null;
  const width = dimensions?.width;
  const height = dimensions?.height;
  const sha = await sha256Hex(bytes);
  const storageKey = input.storageKey ?? `assets/${sha}`;

  const id = input.id ?? createId();
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    // One advisory lock spans put through owner-row commit, closing the
    // "object written, owner not visible" window.
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
          kind: input.kind,
          storage_key: storageKey,
          mime_type: mime,
          byte_size: bytes.byteLength,
          sha256: sha,
          width: width !== undefined && Number.isSafeInteger(width) && width > 0 ? width : null,
          height:
            height !== undefined && Number.isSafeInteger(height) && height > 0 ? height : null,
          provenance: input.provenance,
          created_at: now,
        })
        .returning();
      return inserted;
    } catch (err) {
      if (input.compensatePutOnInsertFailure && !hadOwnerBeforePut) {
        try {
          // The failed INSERT may have aborted the transaction; use the pre-put snapshot.
          await r2.delete(storageKey);
        } catch (cleanupErr) {
          console.error('[persistImageAsset] failed to compensate R2 put:', cleanupErr);
        }
      }
      throw err;
    }
  });
  // Guard the empty-array case so the contract cannot resolve to undefined.
  if (!row) {
    throw new Error('persistSourceAsset: INSERT ... RETURNING returned no row');
  }
  return row;
}

/** Image caller shorthand for the same content-addressed owner protocol. */
export function persistImageAsset(
  db: Db,
  r2: AssetBlobClient,
  input: Omit<Parameters<typeof persistSourceAsset>[2], 'kind'>,
): Promise<SourceAssetRow> {
  return persistSourceAsset(db, r2, { ...input, kind: 'image' });
}

/**
 * Remove one logical owner; delete the object only after its final owner. Shares
 * the write lock protocol.
 */
export async function deleteImageAsset(db: Db, r2: AssetBlobClient, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .select({ id: source_asset.id, storageKey: source_asset.storage_key })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!snapshot) return false;

    await lockImageStorageKey(tx, snapshot.storageKey);

    // The target may have disappeared while waiting for the key lock; re-read.
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
