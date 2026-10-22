// Practice consumes the knowledge-owned frontier decision. Its daily capacity and
// id-list policy remain here; the graph resolver keeps sparse/dense/overflow distinct.
// Existing practice/public exports retain their binding through this module.

import { learnableFrontierResolved } from '@/capabilities/knowledge/public';
import type { Db, Tx } from '@/db/client';

export type { FrontierResolution } from '@/capabilities/knowledge/public';
export { isMasteredForFrontier } from '@/capabilities/knowledge/public';

/** Cap on how many frontier questions the composer pulls in per day (applied by the caller). */
export const FRONTIER_MAX_ITEMS = 5;

type DbLike = Db | Tx;

/**
 * learnableFrontier — thin id-list wrapper over {@link learnableFrontierResolved}.
 *
 * Returns [] on the sparse graph / on any overflow (BYTE-IDENTICAL to the historical
 * contract that composeDailyStream + the stream store depend on — the structural
 * defer-flip). Consumers that must tell overflow from cold-start (frontier_fill_nightly)
 * call learnableFrontierResolved directly and branch on `kind`.
 *
 * @param db Db or Tx — read-only (only `.execute`/`.select` reads; no writes).
 */
export async function learnableFrontier(db: DbLike): Promise<string[]> {
  return (await learnableFrontierResolved(db)).ids;
}
