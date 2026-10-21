// Artifact CREATE seam: every live artifact INSERT also emits a self-sufficient
// experimental:artifact_create event in the same transaction, carrying the full
// initial row snapshot so foldArtifact can reproduce it verbatim. One shared writer
// keeps snapshot construction and the parse barrier in one place.
//
// parseEvent throws inside the caller's transaction, so a malformed snapshot would
// roll back the paired INSERT. Callers pass the real `.returning()` row and the
// snapshot picks exactly the strict columns; a future column cannot leak through
// `.strict()` and false-reject.

import { newId } from '@/core/ids';
import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import type { Tx } from '@/db/client';
import type { artifact } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

// Tx, not Db|Tx: the event must join the caller's transaction so a parse failure
// rolls back the paired INSERT.
type ArtifactRow = typeof artifact.$inferSelect;

/**
 * Map a fresh `.returning()` row to the create snapshot. The explicit column pick
 * keeps future table columns out of the strict parse.
 */
export function artifactRowToCreateSnapshot(row: ArtifactRow | undefined): ArtifactRowSnapshotT {
  // Clear error if `.returning()` ever yields no row.
  if (!row) {
    throw new Error('artifactRowToCreateSnapshot: INSERT … RETURNING returned no row');
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    parent_artifact_id: row.parent_artifact_id,
    knowledge_ids: row.knowledge_ids,
    intent_source: row.intent_source,
    source: row.source,
    source_ref: row.source_ref,
    body_blocks: row.body_blocks,
    attrs: row.attrs,
    tool_kind: row.tool_kind,
    tool_state: row.tool_state,
    generation_status: row.generation_status,
    verification_status: row.verification_status,
    verification_summary: row.verification_summary,
    generated_by: row.generated_by,
    verified_by: row.verified_by,
    history: row.history,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

export interface EmitArtifactCreateParams {
  /** The full initial row snapshot — build it from the INSERT's `.returning()` row. */
  row: ArtifactRowSnapshotT;
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  /** Chain to the causing event when one exists. */
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /** Same timestamp as the paired row's created_at/updated_at. */
  createdAt: Date;
}

/**
 * Emit the create event on the caller's tx and return its id. `ingest_at = createdAt`
 * keeps structural creation out of memory ingestion.
 */
export async function emitArtifactCreateEvent(
  tx: Tx,
  p: EmitArtifactCreateParams,
): Promise<string> {
  const id = newId();
  await writeEvent(tx, {
    id,
    actor_kind: p.actorKind,
    actor_ref: p.actorRef,
    action: 'experimental:artifact_create',
    subject_kind: 'artifact',
    subject_id: p.row.id,
    outcome: 'success',
    payload: { row: p.row },
    caused_by_event_id: p.causedByEventId ?? null,
    task_run_id: p.taskRunId ?? null,
    cost_micro_usd: p.costMicroUsd ?? null,
    created_at: p.createdAt,
    ingest_at: p.createdAt,
  });
  return id;
}
