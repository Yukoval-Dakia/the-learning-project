import { eq } from 'drizzle-orm';
import type { VersionedAssetRefT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';

export interface AssessmentAssetBytes {
  bytes: Uint8Array;
  mime_type: string;
}
export type AssessmentAssetLoader = (
  ref: VersionedAssetRefT,
  signal: AbortSignal,
) => Promise<AssessmentAssetBytes | null>;

/**
 * Default R2 image fetcher: for each asset_id, look up storage_key + mime,
 * fetch bytes via getR2.get(key), base64-encode.
 *
 * Split as an injectable so tests can stub.
 */
export async function defaultImageFetch(
  assetIds: string[],
  db: Db,
): Promise<Array<{ data: string; mediaType: string }>> {
  if (assetIds.length === 0) return [];
  const { getR2 } = await import('@/kernel/object-storage');
  const r2 = getR2();
  const out: Array<{ data: string; mediaType: string }> = [];
  for (const id of assetIds) {
    const [row] = await db
      .select({ storage_key: source_asset.storage_key, mime_type: source_asset.mime_type })
      .from(source_asset)
      .where(eq(source_asset.id, id));
    if (!row) continue;
    const bytes = await r2.get(row.storage_key);
    if (!bytes) continue;
    out.push({
      data: Buffer.from(bytes).toString('base64'),
      mediaType: row.mime_type,
    });
  }
  return out;
}

export function createAssessmentAssetLoader(
  db: Db,
  readBytes: (storageKey: string) => Promise<Uint8Array | null>,
): AssessmentAssetLoader {
  return async (ref, signal) => {
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, ref.asset_id))
      .limit(1);
    if (!row || `sha256:${row.sha256}` !== ref.digest) return null;
    signal.throwIfAborted();
    const bytes = await readBytes(row.storage_key);
    signal.throwIfAborted();
    if (!bytes || bytes.length !== row.byte_size) return null;
    return { bytes, mime_type: row.mime_type };
  };
}

/** Race only against cancellation; always detach the listener on settlement. */
export async function withinAssessmentSignal<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
