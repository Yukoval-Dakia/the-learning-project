import type { Tx } from '@/db/client';
import { upsertMaterializedIdIndex } from './materialized-id-index';

export { projectMistakeVariant, projectMistakeVariantGuarded } from './mistake_variant';
export { hasMistakeVariantGenesisAnchor } from './parity';

export function anchorMistakeVariant(
  tx: Tx,
  materializedId: string,
  anchorEventId: string,
): Promise<void> {
  return upsertMaterializedIdIndex(tx, {
    materialized_id: materializedId,
    anchor_event_id: anchorEventId,
    subject_kind: 'mistake_variant',
  });
}
