// YUK-127 / T-88 P4-A — DB-touching wrapper for the NotePatch apply pipeline.
//
// The pure apply function `applyNotePatch` lives in
// `src/core/blocks/apply-note-patch.ts` so unit tests don't drag in the DB
// chain. This module wraps it with a transactional UPDATE + event write
// against pg.
//
// `persistNoteRefineApply` is the DB-touching wrapper used by the
// `note_refine` pg-boss handler: it loads the artifact, applies the patch,
// UPDATEs body_blocks, and writes an `experimental:note_refine_apply` event
// in a single transaction (per ADR-0006 v2 evidence-first).
//
// Mutator vs propose gating is NOT here — P4-B decides which path calls
// this. P4-A only ships the apply + persist primitives.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { applyNotePatch } from '@/core/blocks/apply-note-patch';
import { type NotePatchT, countNewBlocks, summarizeNotePatch } from '@/core/schema/note-patch';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { type TaskTextResult, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';

type DbLike = Db | Tx;

// Re-export so handler code that already imported from this module keeps
// working without a deep-link to core/.
export { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';

export interface PersistNoteRefineApplyParams {
  db: DbLike;
  artifactId: string;
  patch: NotePatchT;
  // Optional task provenance — only set when the patch comes from a
  // NoteRefineTask LLM run. Manual/test-driven calls leave it undefined.
  taskResult?: TaskTextResult;
  // Optional trigger that caused this refine (mark_wrong attempt event id,
  // mastery delta event, etc.). Lands on the apply event's caused_by chain.
  triggerEventId?: string | null;
  // Override actor_ref; defaults to 'note_refine'.
  actorRef?: string;
  // Optional override id for idempotency / test determinism.
  eventId?: string;
  now?: Date;
}

export interface PersistNoteRefineApplyResult {
  status:
    | 'applied'
    | 'skipped:empty_patch'
    | 'skipped:not_found'
    | 'skipped:archived'
    | 'skipped:version_conflict';
  artifact_id: string;
  event_id?: string;
  ops_count?: number;
  new_blocks?: number;
  artifact_version?: number;
}

/**
 * Applies a NotePatch to an artifact's body_blocks and writes an
 * `experimental:note_refine_apply` event in the same transaction. The event
 * carries the patch summary so downstream consumers (Living Note timeline,
 * undo UI in P4-D) can reconstruct what changed without re-fetching the
 * artifact diff.
 *
 * Empty patch → no-op, no event written (idempotent under "AI produced
 * nothing actionable"). Missing artifact → skip, no event written. Other
 * errors propagate.
 */
export async function persistNoteRefineApply(
  params: PersistNoteRefineApplyParams,
): Promise<PersistNoteRefineApplyResult> {
  const { db, artifactId, patch, taskResult, triggerEventId, actorRef, eventId, now } = params;

  if (patch.ops.length === 0) {
    return { status: 'skipped:empty_patch', artifact_id: artifactId };
  }

  const runInTx = async (tx: Tx): Promise<PersistNoteRefineApplyResult> => {
    const rows = await tx
      .select({
        id: artifact.id,
        body_blocks: artifact.body_blocks,
        version: artifact.version,
        archived_at: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return {
        status: 'skipped:not_found' as const,
        artifact_id: artifactId,
      };
    }
    if (row.archived_at) {
      return {
        status: 'skipped:archived' as const,
        artifact_id: artifactId,
      };
    }

    const newBodyBlocks = applyNotePatch(row.body_blocks, patch);
    const nowAt = now ?? new Date();
    const nextVersion = (row.version ?? 0) + 1;
    const id = eventId ?? createId();

    const updated = await tx
      .update(artifact)
      .set({
        body_blocks: newBodyBlocks as never,
        version: nextVersion,
        updated_at: nowAt,
      })
      .where(and(eq(artifact.id, artifactId), eq(artifact.version, row.version)))
      .returning({ version: artifact.version });
    if (updated.length === 0) {
      return {
        status: 'skipped:version_conflict' as const,
        artifact_id: artifactId,
      };
    }

    const summary = summarizeNotePatch(patch);

    await writeEvent(tx, {
      id,
      session_id: null,
      actor_kind: taskResult ? 'agent' : 'system',
      actor_ref: actorRef ?? 'note_refine',
      action: 'experimental:note_refine_apply',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: {
        artifact_id: artifactId,
        previous_artifact_version: row.version,
        next_artifact_version: nextVersion,
        ops_count: summary.ops_count,
        new_blocks: summary.new_blocks,
        ops: patch.ops,
        ...(taskResult
          ? {
              applied_by: aiAgentRef('NoteRefineTask', taskResult),
            }
          : {}),
      },
      caused_by_event_id: triggerEventId ?? null,
      task_run_id: taskResult?.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
      created_at: nowAt,
    });

    return {
      status: 'applied' as const,
      artifact_id: artifactId,
      event_id: id,
      ops_count: summary.ops_count,
      new_blocks: countNewBlocks(patch),
      artifact_version: nextVersion,
    };
  };

  // Detect Tx vs Db: Tx strips `$client`, Db exposes it.
  if (!('$client' in db)) {
    return runInTx(db as Tx);
  }
  return (db as Db).transaction(runInTx);
}
