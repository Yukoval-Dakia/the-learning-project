// YUK-471 W3-C1β — the artifact CREATE cutover seam.
//
// Every live `artifact` INSERT site ALSO emits a self-sufficient
// `experimental:artifact_create` event in the SAME transaction (additive double-write; the
// per-entity projection flag projectionIsWriter('artifact') stays OFF — this lane never flips it).
// The event carries the FULL initial ArtifactRowSnapshot so foldArtifact can reproduce the row
// VERBATIM (full-snapshot rule, design §5.1). This module is the ONE shared writer the 8 INSERT
// sites call so the snapshot construction + the parse-barrier-safe event shape live in one place.
//
// ── ROLLBACK SAFETY (the critical risk, design §3 #3) ───────────────────────────────────────────
// writeEvent runs parseEvent() which THROWS on a malformed payload — INSIDE the caller tx. So if the
// artifact_create payload failed the ArtifactRowSnapshot.strict() barrier, it would ROLL BACK the
// live INSERT it is paired with. To make the snapshot un-rollbackable, callers INSERT with
// `.returning()` and feed the REAL full DB row here: every one of the 22 columns is materialized
// (DB defaults applied — generation_status / verification_status / version / attrs {} / history []
// / archived_at null …), so the snapshot always has a real value for every strict column and parses.
// `artifactRowToCreateSnapshot` picks EXACTLY the 22 snapshot columns from the returned row, so a
// future 23rd table column can never leak through `.strict()` and false-reject.

import { newId } from '@/core/ids';
import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import type { Tx } from '@/db/client';
import type { artifact } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';

// Tx (not Db|Tx): the create event MUST run on the caller's transaction so a parseEvent throw rolls
// back the paired INSERT. Narrowing to Tx type-enforces the atomic double-write at every call site.
type ArtifactRow = typeof artifact.$inferSelect;

/**
 * Map a freshly-INSERTed (`.returning()`) `artifact` DB row → the full 22-column
 * ArtifactRowSnapshot the create event carries. Explicit column pick (NOT a spread / strict-parse of
 * the whole row) so a future extra table column never leaks into the `.strict()` snapshot and
 * false-rejects at the parseEvent barrier. The DB row already carries materialized values for every
 * column (defaults applied), so the result parses cleanly inside `emitArtifactCreateEvent`.
 */
export function artifactRowToCreateSnapshot(row: ArtifactRow | undefined): ArtifactRowSnapshotT {
  // Defensive null-guard (the 8 INSERT sites all `const [row] = …returning()` — noUncheckedIndexedAccess
  // is off, so TS infers non-undefined). A clear error beats an opaque "Cannot read 'id' of undefined"
  // if `.returning()` ever yields []. Guarding here covers every call site at once.
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
  /** Chain to the causing event (e.g. the RATE event for a learning_intent accept) when one exists. */
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /**
   * The SAME timestamp the paired row's created_at/updated_at carry, so the create event's
   * created_at == the row's timestamps (mirrors the variant_gen / learning_item genesis seams).
   */
  createdAt: Date;
}

/**
 * Emit the self-sufficient `experimental:artifact_create` event on the caller's tx. MUST run on the
 * SAME tx as the paired artifact INSERT (atomic double-write). Returns the create event id (so a
 * caller that wants to chain further events can reference it). parseEvent rejects a malformed
 * snapshot here — see the ROLLBACK SAFETY note above.
 *
 * `ingest_at = createdAt` opts the row OUT of the memory-ingestion outbox (a structural creation
 * base is not a memory-worthy activity — mirrors the variant_gen create + learning_item genesis
 * seams which also stamp ingest_at).
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
