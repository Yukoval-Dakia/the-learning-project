import { inArray } from 'drizzle-orm';
import {
  type FigureOrigin,
  figureOriginFromAssetProvenance,
} from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';

/** Asset provenance read shared by every model-facing figure reader. */
export async function readFigureOrigins(
  db: Db | Tx,
  assetIds: readonly string[],
): Promise<(assetId: string) => FigureOrigin> {
  const ids = [...new Set(assetIds)];
  const rows = ids.length
    ? await db
        .select({ id: source_asset.id, provenance: source_asset.provenance })
        .from(source_asset)
        .where(inArray(source_asset.id, ids))
    : [];
  const provenanceById = new Map(rows.map((row) => [row.id, row.provenance as unknown]));
  return (assetId) => figureOriginFromAssetProvenance(provenanceById.get(assetId));
}
