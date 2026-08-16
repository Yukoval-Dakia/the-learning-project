import type { Tx } from '@/db/client';
import { upsertMaterializedIdIndex } from './materialized-id-index';

export { projectMistakeVariant, projectMistakeVariantGuarded } from './mistake_variant';
export {
  assertMistakeVariantParity,
  hasMistakeVariantGenesisAnchor,
  mistakeVariantLiveRowToSnapshot,
} from './parity';

import { projectionIsWriter } from './sot-flag';

/** Narrow projection gateway for the practice-owned mistake-variant lifecycle. */
export function projectionWritesMistakeVariant(): boolean {
  return projectionIsWriter('mistake_variant');
}

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
