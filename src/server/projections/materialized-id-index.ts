// YUK-471 W1 PR-A2a — write/read helpers for the `materialized_id_index` reverse index.
//
// The index maps a materialized node/edge id → the event (propose/split post-keystone, or
// genesis at backfill) whose accept/seed minted that id. See the table header in
// src/db/schema.ts for the full rationale. The W1 fold reducers key most mutations on the
// event's own `subject_id`, but `propose_new` / `split` mint a node id that is NOT the
// subject_id (it's recorded in the accepting RATE's payload.materialized_ids) — so folding a
// node BY its id needs this explicit id → anchor-event path.
//
// PR-A2a only ADDS these helpers + DB-tests them; they are NOT called from any live write
// path yet (acceptProposal / actions.ts / edges.ts stay untouched). The same-tx accept-time
// write is wired in PR-A2b; the genesis backfill script (PR-A2a) is the other writer.
//
// Db|Tx polymorphism + onConflict shape mirror upsertFsrsState (src/server/fsrs/state.ts).

import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { materialized_id_index } from '@/db/schema';

type DbLike = Db | Tx;

/** Which fold consumes this anchor. (YUK-471 W2: 'goal' joins — DB column is bare `text`,
 * schema.ts:794, so adding the value needs NO migration.) */
export type MaterializedSubjectKind = 'knowledge' | 'knowledge_edge' | 'goal';

export interface UpsertMaterializedIdIndexEntry {
  /** the knowledge.id / knowledge_edge.id being anchored (PK; minted exactly once). */
  materialized_id: string;
  /** the propose/split (post-keystone) or genesis (backfill) event that materialized the id. */
  anchor_event_id: string;
  subject_kind: MaterializedSubjectKind;
}

/**
 * Insert a (materialized_id → anchor_event_id) row, idempotently.
 *
 * The materialized id is minted exactly once, so the row is write-once: `onConflictDoNothing`
 * makes re-runs (backfill replay, at-least-once job delivery) a no-op rather than an error or
 * an overwrite. FIRST WRITE WINS — a later upsert with a different anchor_event_id does NOT
 * clobber the original anchor (the id's true origin event), which is the contract the fold
 * relies on. This is deliberately distinct from upsertFsrsState's onConflictDoUpdate: FSRS
 * state is a moving projection (latest review wins), whereas an anchor is immutable provenance.
 */
export async function upsertMaterializedIdIndex(
  db: DbLike,
  entry: UpsertMaterializedIdIndexEntry,
): Promise<void> {
  await db
    .insert(materialized_id_index)
    .values({
      materialized_id: entry.materialized_id,
      anchor_event_id: entry.anchor_event_id,
      subject_kind: entry.subject_kind,
    })
    .onConflictDoNothing({ target: materialized_id_index.materialized_id });
}

/**
 * Look up the anchor event id for a materialized node/edge id, or null if not indexed.
 *
 * Single-row PK lookup — the fold calls this to find where to start replay for a node whose
 * id is not an event subject_id (propose_new / split).
 */
export async function getAnchorEventId(db: DbLike, materializedId: string): Promise<string | null> {
  const rows = await db
    .select({ anchor_event_id: materialized_id_index.anchor_event_id })
    .from(materialized_id_index)
    .where(eq(materialized_id_index.materialized_id, materializedId))
    .limit(1);
  return rows[0]?.anchor_event_id ?? null;
}
