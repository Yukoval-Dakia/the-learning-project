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
import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import { applyNotePatch } from '@/core/blocks/apply-note-patch';
import { type NotePatchT, countNewBlocks, summarizeNotePatch } from '@/core/schema/note-patch';
import type { Db, Tx } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { type TaskTextResult, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';

type DbLike = Db | Tx;

// Re-export so handler code that already imported from this module keeps
// working without a deep-link to core/.
export { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';

// C1a (YUK-358, ADR-0040 决定1) — the accept-path actor. acceptNoteUpdateProposal
// (src/server/proposals/actions.ts) lands a HUMAN-APPROVED patch through this same
// persist wrapper with actorRef = NOTE_REFINE_ACCEPT_ACTOR. When the actor is the
// accept-path, the user_verified guard in applyNotePatch is exempted: a human
// already approved that exact change through the inbox, so re-rejecting it would
// be wrong. Every OTHER actor (note_refine AI mutator, hub_auto_sync_nightly,
// presence-store apply) keeps the guard ON.
export const NOTE_REFINE_ACCEPT_ACTOR = 'note_refine_accept';

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

    // C1a (YUK-358): the accept-path is the ONLY caller exempt from the
    // user_verified hard boundary — a human approved that patch through the
    // inbox. All other actors keep the guard ON (cross-caller safety net).
    const newBodyBlocks = applyNotePatch(row.body_blocks, patch, {
      enforceUserVerifiedGuard: actorRef !== NOTE_REFINE_ACCEPT_ACTOR,
    });
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

    // YUK-95 P5: keep the L2 cross_link backlink index in sync within the same
    // tx — an AI patch may add/remove crossLinkBlock nodes.
    await syncBlockRefsForArtifact(tx, artifactId, newBodyBlocks);

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

export async function undoNoteRefineApplyEvent(
  db: Db,
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

  // Scope the already-undone check to undo events CAUSED BY this apply event
  // (caused_by_event_id chain) instead of full-scanning every
  // `experimental:note_refine_undo` row. The undo event we write below sets
  // caused_by_event_id = applyEventId, so this is the precise inverse lookup and
  // does not degrade as the global event log grows.
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
      .select({ id: artifact.id, version: artifact.version, archived_at: artifact.archived_at })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw new Error(`artifact ${artifactId} not found`);
    if (target.archived_at) throw new Error(`artifact ${artifactId} archived`);
    const nextVersion = target.version + 1;
    // Optimistic lock: restore only if the artifact is still at the version we
    // loaded. Mirror persistNoteRefineApply's apply-path pattern — check the
    // returned row count and, on a concurrent version bump (0 rows updated),
    // signal version_conflict WITHOUT writing the undo event. Reporting 'undone'
    // here would be a false success (note not restored) AND would let the
    // already_undone guard permanently block a real retry.
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
    // review 2026-05-29: undo restores previous_body_blocks, which may add/remove
    // crossLinkBlock nodes vs the applied state — resync the L2 backlink index in the
    // same tx (mirror the apply-path resync), else the index lags the restored doc.
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
