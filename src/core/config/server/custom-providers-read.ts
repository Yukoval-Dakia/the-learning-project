// YUK-1563 part 4 — custom provider definitions, server read face.
//
// The catalog refresh re-reads this table inside its write lock (YUK-1960). A
// process whose in-memory registry still predates another process's committed
// definition write must never rewrite the custom buckets from that stale copy:
// the write would drop the other process's bucket until the next refresh.

import {
  type CustomProviderRecord,
  customProviderRecordFromRow,
} from '@/core/config/custom-providers';
import type { Db, Tx } from '@/db/client';
import { custom_provider } from '@/db/schema';

const SELECTION = {
  id: custom_provider.id,
  display_name: custom_provider.display_name,
  base_url: custom_provider.base_url,
  api_key_env: custom_provider.api_key_env,
  protocol: custom_provider.protocol,
  created_at: custom_provider.created_at,
  updated_at: custom_provider.updated_at,
} as const;

/** Sorted by id so every projection (registry, catalog buckets) is deterministic. */
export async function selectCustomProviderRecords(
  db: Db | Tx,
): Promise<readonly CustomProviderRecord[]> {
  const rows = await db.select(SELECTION).from(custom_provider);
  return rows
    .map(customProviderRecordFromRow)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Definitions a catalog write must build its custom buckets from. `undefined`
 * means the table could not be read (pre-migration or a transient failure):
 * callers then keep the stored buckets instead of reading every provider as
 * deleted.
 */
export async function readCustomProviderDefinitions(
  db: Db | Tx,
): Promise<readonly CustomProviderRecord[] | undefined> {
  try {
    return await selectCustomProviderRecords(db);
  } catch {
    return undefined;
  }
}
