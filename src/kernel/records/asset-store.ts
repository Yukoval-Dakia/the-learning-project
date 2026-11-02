import { createId } from '@paralleldrive/cuid2';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  CUSTOM_ASSET_MAX_BYTES,
  CUSTOM_ASSET_MIME_TYPES,
  customAssetIdForDigest,
} from '@/core/schema/assessment/presentation';
import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';

// Shared content-addressed asset write path. Dedup happens only at the object
// layer (`storage_key = assets/<sha>`); each call still inserts a distinct
// source_asset row because an asset id is the handle a session pins. kind and
// provenance stay caller-supplied; this module owns the storage/lock mechanism.

/** Blob handle this protocol needs; it never reads objects back. */
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

/** Separate from the mutable source/image adapter; existing clients stay compatible. */
export interface ImmutableAssetBlobClient {
  get(key: string): Promise<Uint8Array | null>;
  putIfAbsent?(key: string, body: Uint8Array, contentType?: string): Promise<'created' | 'exists'>;
}

export class ImmutableAssetError extends Error {
  constructor(
    readonly code: 'immutable_asset_conflict' | 'immutable_asset_unverifiable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImmutableAssetError';
  }
}

/**
 * Complete write-once custom-code protocol. The caller only supplies bytes and
 * server-owned provenance/authorization; this owner derives every content identity.
 * Never use persistSourceAsset's unconditional put for this path.
 */
export async function persistImmutableCustomCodeAsset(
  db: Db,
  blob: ImmutableAssetBlobClient,
  input: {
    bytes: Uint8Array;
    provenance: typeof source_asset.$inferInsert.provenance;
    authorize: (tx: Tx) => Promise<void>;
  },
): Promise<{ row: SourceAssetRow; reused: boolean }> {
  const putIfAbsent = blob.putIfAbsent?.bind(blob);
  if (!putIfAbsent) {
    throw new ImmutableAssetError(
      'immutable_asset_unverifiable',
      'blob adapter does not support conditional creation; no write attempted',
    );
  }
  // Own a stable view across asynchronous hashing, authorization and storage IO.
  const bytes = input.bytes.slice();
  if (bytes.byteLength === 0 || bytes.byteLength > CUSTOM_ASSET_MAX_BYTES) {
    throw new ImmutableAssetError('immutable_asset_conflict', 'custom code size is invalid');
  }
  const sha = await sha256Hex(bytes);
  const id = customAssetIdForDigest(`sha256:${sha}`);
  if (!id) throw new Error('SHA-256 did not produce a custom-code asset identity');
  // Keep old unconditional source writers away from this immutable namespace.
  const storageKey = `assets/custom-code/${sha}`;
  const mime = CUSTOM_ASSET_MIME_TYPES[0];
  const verifyRow = (row: SourceAssetRow) => {
    if (
      row.id !== id ||
      row.sha256 !== sha ||
      row.storage_key !== storageKey ||
      row.kind !== 'text' ||
      row.mime_type !== mime ||
      row.byte_size !== bytes.byteLength ||
      row.width !== null ||
      row.height !== null ||
      row.provenance.source_kind !== 'custom_block_code'
    ) {
      throw new ImmutableAssetError(
        'immutable_asset_conflict',
        'existing custom-code asset identity or metadata differs; original retained',
      );
    }
  };

  return db.transaction(async (tx) => {
    // Authorization locks remain held until the reference's owner row commits.
    await input.authorize(tx);
    await lockImageStorageKey(tx, storageKey);
    const [existing] = await tx.select().from(source_asset).where(eq(source_asset.id, id)).limit(1);
    if (existing) verifyRow(existing);
    const [foreignOwner] = await tx
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(and(eq(source_asset.storage_key, storageKey), ne(source_asset.id, id)))
      .limit(1);
    if (foreignOwner) {
      throw new ImmutableAssetError(
        'immutable_asset_conflict',
        'immutable storage key has a different logical owner; original retained',
      );
    }

    let stored: Uint8Array | null;
    try {
      // Replays with a row are read-only. An orphaned object after a failed or
      // unknown commit can be adopted only after conditional create + byte proof.
      if (!existing) await putIfAbsent(storageKey, bytes, mime);
      stored = await blob.get(storageKey);
    } catch (cause) {
      throw new ImmutableAssetError(
        'immutable_asset_unverifiable',
        'custom-code blob could not be persisted and verified; no reference issued',
        { cause },
      );
    }
    if (stored === null) {
      throw new ImmutableAssetError(
        'immutable_asset_unverifiable',
        'custom-code blob is missing; no repair or reference issued',
      );
    }
    if (
      stored.byteLength !== bytes.byteLength ||
      !stored.every((byte, index) => byte === bytes[index])
    ) {
      throw new ImmutableAssetError(
        'immutable_asset_conflict',
        'stored custom-code bytes differ; original object and row retained',
      );
    }
    if (existing) return { row: existing, reused: true };

    const inserted = await tx
      .insert(source_asset)
      .values({
        id,
        kind: 'text',
        storage_key: storageKey,
        mime_type: mime,
        byte_size: bytes.byteLength,
        sha256: sha,
        width: null,
        height: null,
        provenance: input.provenance,
        created_at: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: source_asset.id });
    // A conflicting INSERT is never proof that this payload was stored. A
    // truncated-id collision may have committed under a different storage lock.
    const [row] = await tx.select().from(source_asset).where(eq(source_asset.id, id)).limit(1);
    if (!row) {
      throw new ImmutableAssetError(
        'immutable_asset_unverifiable',
        'custom-code owner row could not be verified; no reference issued',
      );
    }
    verifyRow(row);
    // No compensation delete: blob success + DB failure/unknown outcome retains
    // an immutable object for verification on retry, never deletes shared data.
    return { row, reused: inserted.length === 0 };
  });
}

export class ImmutableAssetDeleteForbiddenError extends Error {
  readonly code = 'immutable_asset_delete_forbidden';

  constructor() {
    super('Shared immutable custom-code assets cannot be removed by generic asset deletion');
    this.name = 'ImmutableAssetDeleteForbiddenError';
  }
}

/**
 * Remove one source/image owner; delete the object only after its final owner.
 * Shared single-row custom-code assets require an explicit reference lifecycle,
 * so this generic deletion protocol rejects them under the storage-key lock.
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
      .select({
        id: source_asset.id,
        storageKey: source_asset.storage_key,
        provenance: source_asset.provenance,
      })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!live) return false;
    if (
      live.provenance?.source_kind === 'custom_block_code' ||
      live.storageKey.startsWith('assets/custom-code/')
    ) {
      throw new ImmutableAssetDeleteForbiddenError();
    }

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
