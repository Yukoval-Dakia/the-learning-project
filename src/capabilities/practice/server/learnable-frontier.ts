// Practice consumes the knowledge-owned frontier decision. This wrapper preserves the
// historical id-list contract: [] on a sparse graph or overflow. Callers that must
// distinguish overflow from cold start call learnableFrontierResolved directly.

import { learnableFrontierResolved } from '@/capabilities/knowledge/public';
import type { Db, Tx } from '@/db/client';

export type { FrontierResolution } from '@/capabilities/knowledge/public';
export { isMasteredForFrontier } from '@/capabilities/knowledge/public';

/** Cap on how many frontier questions the composer pulls in per day (applied by the caller). */
export const FRONTIER_MAX_ITEMS = 5;

type DbLike = Db | Tx;

/** Thin id-list wrapper over {@link learnableFrontierResolved}. */
export async function learnableFrontier(db: DbLike): Promise<string[]> {
  return (await learnableFrontierResolved(db)).ids;
}
