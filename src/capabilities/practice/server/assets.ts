import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { createAssessmentAssetLoader as createAssetLoader } from '@/kernel/records/assessment-assets';

export function createAssessmentAssetLoader(db: Db) {
  return createAssetLoader(db, async (key) => {
    const { getR2 } = await import('@/server/r2');
    return getR2().get(key);
  });
}

/**
 * Default R2 image fetcher: for each asset_id, look up storage_key + mime,
 * fetch bytes via getR2().get(key), base64-encode.
 *
 * Split as an injectable so tests can stub. Also reused by T9 sanity script.
 */
export async function defaultImageFetch(
  assetIds: string[],
  db: Db,
): Promise<Array<{ data: string; mediaType: string }>> {
  if (assetIds.length === 0) return [];
  const { getR2 } = await import('@/server/r2');
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
