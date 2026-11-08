import { inArray } from 'drizzle-orm';
import type {
  LearnerHandwritingMarkerT,
  SharedMaterialT,
} from '@/core/schema/assessment/materials';
import {
  type FigureOrigin,
  figureOriginFromAssetProvenance,
  learnerHandwritingMarker,
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

/** Learner-handwriting marker per figure material: a stored marker wins, otherwise the figure's origin decides. */
export async function readFigureMaterialMarkers(
  db: Db | Tx,
  materials: readonly SharedMaterialT[],
): Promise<Map<string, LearnerHandwritingMarkerT>> {
  const figures = materials.filter((m) => m.kind === 'figure');
  const originOf = await readFigureOrigins(
    db,
    figures.map((m) => m.asset.asset_id),
  );
  return new Map(
    figures.map((m) => [
      m.material_id,
      learnerHandwritingMarker(m.contains_learner_handwriting, originOf(m.asset.asset_id)),
    ]),
  );
}
