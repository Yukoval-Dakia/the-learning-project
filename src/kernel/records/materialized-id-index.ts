import type { Db, Tx } from '@/db/client';
import { materialized_id_index } from '@/db/schema';

type DbLike = Db | Tx;

/** Which fold consumes this anchor. The DB column is plain text, so new values need no migration. */
export type MaterializedSubjectKind =
  | 'knowledge'
  | 'knowledge_edge'
  | 'goal'
  | 'mistake_variant'
  | 'learning_item'
  | 'artifact';

export interface UpsertMaterializedIdIndexEntry {
  /** the knowledge.id / knowledge_edge.id being anchored (PK; minted exactly once). */
  materialized_id: string;
  /** The event that materialized the id: a runtime propose/split or a genesis backfill. */
  anchor_event_id: string;
  subject_kind: MaterializedSubjectKind;
}

/**
 * Insert one anchor idempotently. First write wins: the id is minted once and an anchor
 * is immutable provenance, so re-runs must not overwrite it (unlike a moving projection).
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
