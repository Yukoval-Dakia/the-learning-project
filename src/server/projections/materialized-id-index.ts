// Read/write helpers for `materialized_id_index`, which maps a minted node/edge id to
// the event that created it. The fold needs this for ids that are not event subjects:
// propose_new/split record the minted id in the accepting rate's materialized_ids.

import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { materialized_id_index } from '@/db/schema';

type DbLike = Db | Tx;

export type {
  MaterializedSubjectKind,
  UpsertMaterializedIdIndexEntry,
} from '@/kernel/records/materialized-id-index';
export { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';

/** Return the anchor event id for a minted id, or null when it is not indexed. */
export async function getAnchorEventId(db: DbLike, materializedId: string): Promise<string | null> {
  const rows = await db
    .select({ anchor_event_id: materialized_id_index.anchor_event_id })
    .from(materialized_id_index)
    .where(eq(materialized_id_index.materialized_id, materializedId))
    .limit(1);
  return rows[0]?.anchor_event_id ?? null;
}
