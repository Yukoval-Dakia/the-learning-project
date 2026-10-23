// Transactional wrapper around the pure `applyNotePatch`: updates body_blocks
// and writes the apply event in one transaction. Mutator-vs-propose gating lives
// in the job.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { type TaskTextResult, aiAgentRef } from '@/ai/task-result';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import { applyNotePatch, filterMissingNotePatchTargets } from '@/core/blocks/apply-note-patch';
import { type NotePatchT, countNewBlocks, summarizeNotePatch } from '@/core/schema/note-patch';
import type { Db, Tx } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { writeEvent } from '@/kernel/events';

type DbLike = Db | Tx;

// Re-export so existing importers avoid a deep link to core/.
export { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';

// A human already approved this exact patch in the inbox, so the user-verified
// guard is exempt for this actor. Every other actor keeps it on.
export const NOTE_REFINE_ACCEPT_ACTOR = 'note_refine_accept';

// Default AI mutator actor. The rate breaker counts only this actor, so human
// accepts never push it toward a trip.
export const NOTE_REFINE_AUTOAPPLY_ACTOR = 'note_refine';

export interface PersistNoteRefineApplyParams {
  db: DbLike;
  artifactId: string;
  patch: NotePatchT;
  // Provenance, only for an LLM-run patch.
  taskResult?: TaskTextResult;
  // The trigger that caused this refine; lands on caused_by.
  triggerEventId?: string | null;
  // Defaults to the AI mutator actor.
  actorRef?: string;
  eventId?: string;
  now?: Date;
}

export interface PersistNoteRefineApplyResult {
  status:
    | 'applied'
    | 'skipped:empty_patch'
    | 'skipped:target_not_found'
    | 'skipped:not_found'
    | 'skipped:archived'
    | 'skipped:version_conflict';
  artifact_id: string;
  event_id?: string;
  ops_count?: number;
  new_blocks?: number;
  artifact_version?: number;
  skipped_ops?: number;
}

export interface NoteRefineChangeRow {
  event_id: string;
  artifact_id: string;
  created_at: Date;
  actor_ref: string;
  ops_count: number;
  new_blocks: number;
  previous_artifact_version: number;
  next_artifact_version: number;
  undone: boolean;
}

function noteRefineReversePatch(bodyBlocks: unknown, previousArtifactVersion: number) {
  return {
    kind: 'restore_body_blocks' as const,
    body_blocks: bodyBlocks,
    artifact_version: previousArtifactVersion,
  };
}

/**
 * Applies the patch and writes the apply event atomically. Empty patches and
 * missing artifacts write nothing. Automated callers skip ghost targets
 * individually; a human-approved patch stays all-or-nothing.
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

    // Check targets inside the tx so deferred patches are covered. A ghost target
    // skips only itself; the human accept path stays exact.
    const filtered =
      actorRef === NOTE_REFINE_ACCEPT_ACTOR
        ? {
            patch,
            body_blocks: applyNotePatch(row.body_blocks, patch, {
              enforceUserVerifiedGuard: false,
            }),
            skipped_ops: 0,
          }
        : filterMissingNotePatchTargets(row.body_blocks, patch);
    if (filtered.patch.ops.length === 0) {
      return {
        status: 'skipped:target_not_found' as const,
        artifact_id: artifactId,
        skipped_ops: filtered.skipped_ops,
      };
    }
    const effectivePatch = filtered.patch;
    const newBodyBlocks = filtered.body_blocks;
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

    // A patch may add or remove cross-links; keep the backlink index in this tx.
    await syncBlockRefsForArtifact(tx, artifactId, newBodyBlocks);

    const summary = summarizeNotePatch(effectivePatch);

    await writeEvent(tx, {
      id,
      session_id: null,
      actor_kind: taskResult ? 'agent' : 'system',
      actor_ref: actorRef ?? NOTE_REFINE_AUTOAPPLY_ACTOR,
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
        ops: effectivePatch.ops,
        ...(filtered.skipped_ops > 0 ? { skipped_target_ops: filtered.skipped_ops } : {}),
        previous_body_blocks: row.body_blocks,
        reverse_patch: noteRefineReversePatch(row.body_blocks, row.version),
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
      new_blocks: countNewBlocks(effectivePatch),
      artifact_version: nextVersion,
      ...(filtered.skipped_ops > 0 ? { skipped_ops: filtered.skipped_ops } : {}),
    };
  };

  // Detect Tx vs Db: Tx strips `$client`, Db exposes it.
  if (!('$client' in db)) {
    return runInTx(db as Tx);
  }
  return (db as Db).transaction(runInTx);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function listNoteRefineChanges(
  db: DbLike,
  opts: { artifactId?: string; since?: Date; limit?: number } = {},
): Promise<NoteRefineChangeRow[]> {
  const conditions = [eq(event.action, 'experimental:note_refine_apply')];
  if (opts.artifactId) conditions.push(eq(event.subject_id, opts.artifactId));
  if (opts.since) conditions.push(gte(event.created_at, opts.since));
  const query = db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at), desc(event.id));
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit);
  const applyEventIds = rows.map((row) => row.id);
  const undoRows =
    applyEventIds.length === 0
      ? []
      : await db
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:note_refine_undo'),
              inArray(event.caused_by_event_id, applyEventIds),
            ),
          );
  const undoneIds = new Set(
    undoRows
      .map((row) => (row.payload as { undone_event_id?: unknown }).undone_event_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  return rows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return {
      event_id: row.id,
      artifact_id: row.subject_id,
      created_at: row.created_at,
      actor_ref: row.actor_ref,
      ops_count: toNumber(payload.ops_count),
      new_blocks: toNumber(payload.new_blocks),
      previous_artifact_version: toNumber(payload.previous_artifact_version),
      next_artifact_version: toNumber(payload.next_artifact_version),
      undone: undoneIds.has(row.id),
    };
  });
}

// Accepts Db | Tx so a retract can run the undo inside its own transaction; the
// nested transaction becomes a savepoint there.
export async function undoNoteRefineApplyEvent(
  db: DbLike,
  params: { applyEventId: string; actorRef?: string; now?: Date },
): Promise<{
  status: 'undone' | 'skipped:already_undone' | 'skipped:version_conflict';
  artifact_id: string;
  event_id?: string;
  artifact_version?: number;
}> {
  const rows = await db.select().from(event).where(eq(event.id, params.applyEventId)).limit(1);
  const applyRow = rows[0];
  if (!applyRow || applyRow.action !== 'experimental:note_refine_apply') {
    throw new Error(`note refine apply event ${params.applyEventId} not found`);
  }

  // Chain-scoped lookup keeps this independent of event-log growth.
  const undoRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:note_refine_undo'),
        eq(event.caused_by_event_id, params.applyEventId),
      ),
    );
  const alreadyUndone = undoRows.some(
    (row) => (row.payload as { undone_event_id?: unknown }).undone_event_id === params.applyEventId,
  );
  if (alreadyUndone) {
    return { status: 'skipped:already_undone', artifact_id: applyRow.subject_id };
  }

  const payload = applyRow.payload as {
    previous_body_blocks?: unknown;
    previous_artifact_version?: unknown;
  };
  if (!payload.previous_body_blocks) {
    throw new Error(`note refine apply event ${params.applyEventId} has no previous_body_blocks`);
  }

  const artifactId = applyRow.subject_id;
  const now = params.now ?? new Date();
  const undoEventId = `${params.applyEventId}_undo`;

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select({
        id: artifact.id,
        version: artifact.version,
        archived_at: artifact.archived_at,
        // The undo leaves history untouched, so carry the current value on the event.
        history: artifact.history,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw new Error(`artifact ${artifactId} not found`);
    if (target.archived_at) throw new Error(`artifact ${artifactId} archived`);
    const nextVersion = target.version + 1;
    // Restore only from the expected version. On a concurrent bump, report the
    // conflict without writing the undo event: a false 'undone' would also make
    // the already-undone guard block a real retry.
    const restored = await tx
      .update(artifact)
      .set({
        body_blocks: payload.previous_body_blocks as never,
        version: nextVersion,
        updated_at: now,
      })
      .where(and(eq(artifact.id, artifactId), eq(artifact.version, target.version)))
      .returning({ version: artifact.version });
    if (restored.length === 0) {
      return {
        status: 'skipped:version_conflict' as const,
        artifact_id: artifactId,
      };
    }
    // The restored body may add or remove cross-links, so resync the index here.
    await syncBlockRefsForArtifact(tx, artifactId, payload.previous_body_blocks);
    await writeEvent(tx, {
      id: undoEventId,
      actor_kind: 'user',
      actor_ref: params.actorRef ?? 'self',
      action: 'experimental:note_refine_undo',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: {
        artifact_id: artifactId,
        undone_event_id: params.applyEventId,
        restored_from_artifact_version: target.version,
        restored_to_artifact_version: nextVersion,
        source_previous_artifact_version: payload.previous_artifact_version ?? null,
        // Self-sufficient fold fields: the undo changes body and version only, so
        // these let a rebuild reproduce the restore without replaying ops.
        body_blocks: payload.previous_body_blocks,
        next_artifact_version: nextVersion,
        history_after: target.history,
      },
      caused_by_event_id: params.applyEventId,
      created_at: now,
    });
    return {
      status: 'undone' as const,
      artifact_id: artifactId,
      event_id: undoEventId,
      artifact_version: nextVersion,
    };
  });
}
