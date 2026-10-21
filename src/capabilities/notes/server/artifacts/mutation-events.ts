// Artifact edit and lifecycle fold events. Every live artifact UPDATE also emits
// these in the same transaction, built from the values actually written, so a
// projection rebuild reproduces the row instead of replaying ops. A malformed
// payload throws inside the tx and rolls the paired UPDATE back.

import { newId } from '@/core/ids';
import type {
  ArtifactBodyBlocksT,
  ArtifactHistoryEntryT,
  NoteVerificationResultT,
} from '@/core/schema/business';
import type { Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';

// Loosely typed here; parseEvent validates against the canonical AgentRef schema.
type AgentRefValue = Record<string, unknown>;

export interface EmitBodyBlocksEditParams {
  /** = artifact.id. */
  subjectId: string;
  previousArtifactVersion: number;
  /** Must be greater than previousArtifactVersion; a non-advancing edit is a writer bug. */
  nextArtifactVersion: number;
  /** The AFTER body, read verbatim by the fold. */
  bodyBlocks: ArtifactBodyBlocksT;
  /** Previous body for revert; null on the first write. */
  previousBodyBlocks: ArtifactBodyBlocksT | null;
  /** Full after-history, or the history column parity check fails. */
  historyAfter: ArtifactHistoryEntryT[];
  actorKind: 'user' | 'agent';
  actorRef: string;
  /** Reuse the writer's event id (e.g. the one stamped into a history entry). */
  eventId?: string;
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /** Must equal the paired row's updated_at. */
  createdAt: Date;
  /**
   * Keep this event out of memory ingestion. True for new projection-only events
   * (note_generate); false when replacing an existing user activity so ingestion
   * behaviour is unchanged.
   */
  optOutMemoryIngestion?: boolean;
}

/**
 * Emit `experimental:body_blocks_edit` on the caller's tx, atomically with the
 * paired body UPDATE. Returns the event id.
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
  /** The full new attrs (required for set_attrs). */
  attrs?: Record<string, unknown>;
  /** Only when the UPDATE pushed a history entry. */
  historyAfter?: ArtifactHistoryEntryT[];
  /** Version after the UPDATE; a proposal archive bumps it to invalidate editors. */
  nextVersion: number;
  actorKind: 'user' | 'agent' | 'system';
  actorRef: string;
  eventId?: string;
  causedByEventId?: string | null;
  taskRunId?: string | null;
  costMicroUsd?: number | null;
  /** Must equal the paired row's updated_at. */
  createdAt: Date;
  /**
   * Lifecycle events are projection plumbing whose user-visible activity is
   * already represented elsewhere, so they stay out of memory ingestion by
   * default to avoid double-counting.
   */
  optOutMemoryIngestion?: boolean;
}

/**
 * Emit `experimental:artifact_lifecycle` on the caller's tx, atomically with the
 * paired UPDATE. Only the columns the UPDATE touched are carried. Returns the
 * event id.
 */
export async function emitArtifactLifecycleEvent(
  tx: Tx,
  p: EmitArtifactLifecycleParams,
): Promise<string> {
  const id = p.eventId ?? newId();
  // Only carried columns: an undefined would be dropped by JSON anyway, and a
  // stray key would fail the strict barrier.
  const payload: Record<string, unknown> = { op: p.op, next_version: p.nextVersion };
  if (p.archivedAt !== undefined) payload.archived_at = p.archivedAt;
  if (p.generationStatus !== undefined) payload.generation_status = p.generationStatus;
  if (p.verificationStatus !== undefined) payload.verification_status = p.verificationStatus;
  if (p.verificationSummary !== undefined) payload.verification_summary = p.verificationSummary;
  if (p.generatedBy !== undefined) payload.generated_by = p.generatedBy;
  if (p.verifiedBy !== undefined) payload.verified_by = p.verifiedBy;
  if (p.attrs !== undefined) payload.attrs = p.attrs;
  if (p.historyAfter !== undefined) payload.history_after = p.historyAfter;
  // Structural plumbing opts out by default; pass false for a memory-worthy op.
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
