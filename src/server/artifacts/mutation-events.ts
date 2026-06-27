// YUK-471 W3-C1γ — the artifact EDIT / LIFECYCLE cutover seams.
//
// Companion to create-event.ts (the C1β INSERT seam). Every live `artifact` UPDATE site ALSO emits a
// self-sufficient canonical event in the SAME transaction (additive double-write; the per-entity
// projection flag projectionIsWriter('artifact') stays OFF — this lane never flips it) so foldArtifact
// reproduces the mutated columns VERBATIM (design §5.1):
//   - emitArtifactBodyBlocksEditEvent → experimental:body_blocks_edit (hand edit + section edit + the
//     note_generate body) carrying the full AFTER body_blocks + previous + after-history + version.
//   - emitArtifactLifecycleEvent → experimental:artifact_lifecycle (archive/unarchive + generation/
//     verification status + provenance + set_attrs) carrying exactly the columns the UPDATE touched.
//
// ── ROLLBACK SAFETY (the critical risk, mirror create-event.ts) ─────────────────────────────────
// writeEvent runs parseEvent() which THROWS on a malformed payload — INSIDE the caller tx. A malformed
// event would ROLL BACK the live UPDATE it is paired with. So callers build these payloads from REAL
// post-UPDATE values (the after body_blocks they just wrote, the version the `.returning()` reported),
// never from a guessed shape. Tx-only (NOT Db|Tx) type-enforces the atomic double-write at every site.

import { newId } from '@/core/ids';
import type {
  ArtifactBodyBlocksT,
  ArtifactHistoryEntryT,
  NoteVerificationResultT,
} from '@/core/schema/business';
import type { Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';

// AgentRef value shape (artifact.generated_by / verified_by). Loosely typed at this seam — the
// parseEvent barrier validates it against the canonical AgentRef schema.
type AgentRefValue = Record<string, unknown>;

export interface EmitBodyBlocksEditParams {
  /** = artifact.id. */
  subjectId: string;
  previousArtifactVersion: number;
  /** MUST be > previousArtifactVersion (schema superRefine — a non-advancing edit is a writer bug). */
  nextArtifactVersion: number;
  /** The AFTER body the UPDATE wrote (the fold reads it verbatim). */
  bodyBlocks: ArtifactBodyBlocksT;
  /** The BEFORE body, for revert; null = cold first write (no prior body). */
  previousBodyBlocks: ArtifactBodyBlocksT | null;
  /** Full after-history (else the `history` column parity false-fails). */
  historyAfter: ArtifactHistoryEntryT[];
  actorKind: 'user' | 'agent';
  actorRef: string;
  /** Pin the event id to the writer's event id (e.g. the one stamped into a history entry). */
  eventId?: string;
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /** The SAME timestamp the paired row's updated_at carries (fold updated_at = event created_at). */
  createdAt: Date;
  /**
   * Opt this fold-source event OUT of the memory-ingestion outbox (stamp ingest_at = createdAt,
   * mirror create-event.ts). Use TRUE for a NEW additive event that represents pure projection
   * plumbing (the note_generate body write) rather than a memory-worthy activity. Leave FALSE for a
   * MIGRATED event that REPLACES an existing outbox event (the hand edit / section edit) so the
   * memory-ingestion behaviour is byte-preserved.
   */
  optOutMemoryIngestion?: boolean;
}

/**
 * Emit the self-sufficient `experimental:body_blocks_edit` event on the caller's tx. MUST run on the
 * SAME tx as the paired body UPDATE (atomic double-write). Returns the event id.
 */
export async function emitArtifactBodyBlocksEditEvent(
  tx: Tx,
  p: EmitBodyBlocksEditParams,
): Promise<string> {
  const id = p.eventId ?? newId();
  await writeEvent(tx, {
    id,
    session_id: null,
    actor_kind: p.actorKind,
    actor_ref: p.actorRef,
    action: 'experimental:body_blocks_edit',
    subject_kind: 'artifact',
    subject_id: p.subjectId,
    outcome: 'success',
    payload: {
      previous_artifact_version: p.previousArtifactVersion,
      next_artifact_version: p.nextArtifactVersion,
      body_blocks: p.bodyBlocks,
      previous_body_blocks: p.previousBodyBlocks,
      history_after: p.historyAfter,
    },
    caused_by_event_id: p.causedByEventId ?? null,
    task_run_id: p.taskRunId ?? null,
    cost_micro_usd: p.costMicroUsd ?? null,
    created_at: p.createdAt,
    ...(p.optOutMemoryIngestion ? { ingest_at: p.createdAt } : {}),
  });
  return id;
}

export type ArtifactLifecycleOp =
  | 'archive'
  | 'unarchive'
  | 'set_generation_status'
  | 'set_verification_status'
  | 'set_attrs';

export interface EmitArtifactLifecycleParams {
  /** = artifact.id. */
  subjectId: string;
  op: ArtifactLifecycleOp;
  /** archive → a non-null Date; unarchive → null; other ops omit it (undefined). */
  archivedAt?: Date | null;
  generationStatus?: string;
  verificationStatus?: string;
  verificationSummary?: NoteVerificationResultT | null;
  generatedBy?: AgentRefValue | null;
  verifiedBy?: AgentRefValue | null;
  /** The full new attrs jsonb (required when op='set_attrs'). */
  attrs?: Record<string, unknown>;
  /** Full after-history — carry ONLY when the UPDATE pushed a history entry. */
  historyAfter?: ArtifactHistoryEntryT[];
  /** The version the row carries AFTER the UPDATE (verbatim; archive/status ops do not bump). */
  nextVersion: number;
  actorKind: 'user' | 'agent' | 'system';
  actorRef: string;
  eventId?: string;
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /** The SAME timestamp the paired row's updated_at carries. */
  createdAt: Date;
  /**
   * Opt OUT of the memory-ingestion outbox (stamp ingest_at = createdAt). Lifecycle events are pure
   * projection plumbing (a status flip / attrs update / archive — the user-visible activity, if any,
   * is already represented by its own event such as experimental:note_verify or suppress), so they
   * default to opting OUT to avoid double-counting + spending background memory budget on plumbing.
   */
  optOutMemoryIngestion?: boolean;
}

/**
 * Emit the self-sufficient `experimental:artifact_lifecycle` event on the caller's tx. MUST run on the
 * SAME tx as the paired lifecycle/attrs UPDATE. The payload carries EXACTLY the columns the UPDATE
 * touched (an omitted field = the column was left unchanged); the reducer applies whatever is carried.
 * Returns the event id.
 */
export async function emitArtifactLifecycleEvent(
  tx: Tx,
  p: EmitArtifactLifecycleParams,
): Promise<string> {
  const id = p.eventId ?? newId();
  // Build the payload from only the carried columns — never smuggle an `undefined` past the
  // `.strict()` barrier (a stray key fails loud; an undefined value would JSON-drop anyway).
  const payload: Record<string, unknown> = { op: p.op, next_version: p.nextVersion };
  if (p.archivedAt !== undefined) payload.archived_at = p.archivedAt;
  if (p.generationStatus !== undefined) payload.generation_status = p.generationStatus;
  if (p.verificationStatus !== undefined) payload.verification_status = p.verificationStatus;
  if (p.verificationSummary !== undefined) payload.verification_summary = p.verificationSummary;
  if (p.generatedBy !== undefined) payload.generated_by = p.generatedBy;
  if (p.verifiedBy !== undefined) payload.verified_by = p.verifiedBy;
  if (p.attrs !== undefined) payload.attrs = p.attrs;
  if (p.historyAfter !== undefined) payload.history_after = p.historyAfter;
  // Lifecycle events default to opting OUT of memory ingestion (structural plumbing); a caller can
  // pass optOutMemoryIngestion:false to feed the outbox if a future op IS a memory-worthy activity.
  const optOut = p.optOutMemoryIngestion ?? true;
  await writeEvent(tx, {
    id,
    session_id: null,
    actor_kind: p.actorKind,
    actor_ref: p.actorRef,
    action: 'experimental:artifact_lifecycle',
    subject_kind: 'artifact',
    subject_id: p.subjectId,
    outcome: 'success',
    payload,
    caused_by_event_id: p.causedByEventId ?? null,
    task_run_id: p.taskRunId ?? null,
    cost_micro_usd: p.costMicroUsd ?? null,
    created_at: p.createdAt,
    ...(optOut ? { ingest_at: p.createdAt } : {}),
  });
  return id;
}
