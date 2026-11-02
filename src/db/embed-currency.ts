// Shared embed-vector currency rule (YUK-1603): a stored vector is usable as a
// CURRENT retrieval result only when it was stamped by the current EMBED_VERSION
// and computed from the row revision it still carries (embed_source_revision).
//
// SQL + JS twins live together so the retrieval sites and the app-side checks
// (questionVectorInvalidReason, the backfill currency sweep) cannot drift — same
// pattern as notDraftPredicate/isPoolVisible in src/db/predicates.ts.
//
// NULL embed_source_revision = vector written before the column existed: provenance
// unknown, so it stays usable until the backfill's currency sweep re-stamps it (or
// re-embeds on hash drift). Callers must keep their own `embedding IS NOT NULL`
// check — a NULLed vector keeps its old embed_version and would otherwise pass.

import { type Column, type SQL, sql } from 'drizzle-orm';

import { EMBED_VERSION } from '@/core/embed-source';

export interface EmbedCurrencyColumns {
  version: Column;
  embed_version: Column;
  embed_source_revision: Column;
}

/** SQL twin: vector stamped by the current EMBED_VERSION from the current row revision. */
export function embedCurrencyPredicate(cols: EmbedCurrencyColumns): SQL {
  return sql`(${cols.embed_version} = ${EMBED_VERSION} AND (${cols.embed_source_revision} IS NULL OR ${cols.embed_source_revision} = ${cols.version}))`;
}

/** JS twin of the revision half. Unknown provenance (NULL) is NOT stale. */
export function isEmbedRevisionCurrent(row: {
  version: number;
  embed_source_revision: number | null;
}): boolean {
  return row.embed_source_revision === null || row.embed_source_revision === row.version;
}
