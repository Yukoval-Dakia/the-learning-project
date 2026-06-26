import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { ArtifactBodyBlocksT, ArtifactHistoryEntryT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { emitArtifactBodyBlocksEditEvent } from '@/server/artifacts/mutation-events';
import { ApiError } from '@/server/http/errors';
// YUK-471 W3-C3 — the per-entity SoT-flip wiring. ON → the projection write-through is the row writer;
// OFF (default) → the imperative UPDATE stays the SoT and the parity assert catches fold↔row drift
// during the double-write phase. Gated on hasArtifactGenesisAnchor (a pre-W3 un-backfilled artifact
// folds to null → stays imperative; mirrors the W2 goal queries pattern).
import { projectArtifactGuarded } from '@/server/projections/artifact';
import {
  artifactLiveRowToSnapshot,
  assertArtifactParity,
  hasArtifactGenesisAnchor,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';

// ADR-0033 D1 (YUK-309) — body_blocks block-tree editing is a NOTE-ONLY write path.
// Opaque artifact types (tool_quiz, interactive) MUST keep body_blocks null and never
// participate in the cross_link mesh; editing them here would (1) break the D1 opaque
// invariant and (2) make the row a mesh source via syncBlockRefsForArtifact. Guarding the
// edited artifact's type to NOTE_TYPES closes both at the source side.
const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;

export interface EditArtifactBodyBlocksParams {
  db: Db;
  artifactId: string;
  expectedArtifactVersion: number;
  bodyBlocks: ArtifactBodyBlocksT;
  actorRef?: string;
  eventId?: string;
  now?: Date;
}

export interface EditArtifactBodyBlocksResult {
  artifact_id: string;
  artifact_version: number;
  body_blocks: ArtifactBodyBlocksT;
  event_id: string;
}

export async function editArtifactBodyBlocks(
  params: EditArtifactBodyBlocksParams,
): Promise<EditArtifactBodyBlocksResult> {
  const now = params.now ?? new Date();
  const eventId = params.eventId ?? createId();
  const actorRef = params.actorRef ?? 'artifact_block_tree_editor';
  const bodyBlocks = ArtifactBodyBlocks.parse(params.bodyBlocks);

  return params.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifact.id,
        type: artifact.type,
        // W3-C1γ — the BEFORE body, carried on the body_blocks_edit event as previous_body_blocks
        // (for revert; the existing optimistic-lock SELECT already reads the row, so this is free).
        body_blocks: artifact.body_blocks,
        history: artifact.history,
        archived_at: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, params.artifactId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
    // YUK-309: refuse to write a block-tree onto an opaque artifact type. Without this
    // a hand-crafted PATCH against an interactive / tool_quiz id would write body_blocks
    // (breaking the ADR-0033 D1 opaque invariant) and turn the row into a mesh source.
    if (!(NOTE_TYPES as readonly string[]).includes(row.type)) {
      throw new ApiError(
        'conflict',
        `artifact ${params.artifactId} has type ${row.type}; body_blocks editing is only allowed for note artifacts`,
        409,
      );
    }
    if (row.archived_at) {
      throw new ApiError('conflict', `artifact ${params.artifactId} is archived`, 409);
    }
    if (row.version !== params.expectedArtifactVersion) {
      throw new ApiError('conflict', `artifact ${params.artifactId} concurrently modified`, 409);
    }

    const nextArtifactVersion = row.version + 1;
    const history = Array.isArray(row.history) ? [...row.history] : [];
    history.push({
      version: nextArtifactVersion,
      at: now,
      by: { by: 'user' },
      summary_md: 'Edited block tree body',
      action: 'body_blocks_edit',
      event_id: eventId,
      previous_artifact_version: row.version,
      next_artifact_version: nextArtifactVersion,
    });

    // YUK-471 W3-C3 — applicability gate captured BEFORE the fold-source event is written (mirror the
    // W2 goal queries pattern). A pre-W3 artifact with no create/genesis/index anchor folds to null, so
    // it must STAY on the imperative path (the projection would refuse to write it / the assert would
    // false-mismatch fold-null vs the live row).
    const wasEventSourced = await hasArtifactGenesisAnchor(tx, params.artifactId);

    // YUK-471 W3-C1γ — emit the self-sufficient `experimental:body_blocks_edit` event FIRST (BEFORE the
    // row write) so both the projection (ON) and the parity assert (OFF) read it. It carries the full
    // AFTER body_blocks + previous (for revert) + after-history + version (all computed above, no
    // dependency on the UPDATE), so foldArtifact reproduces the row VERBATIM. Same tx — a malformed
    // payload rolls back the whole edit (parseEvent barrier). The event id stays = eventId (the value
    // pinned into the history entry above). optOutMemoryIngestion:false preserves the OLD edit event's
    // outbox behaviour (a hand edit IS a user activity — byte-preserve the prior ingest_at=NULL).
    await emitArtifactBodyBlocksEditEvent(tx, {
      subjectId: params.artifactId,
      eventId,
      previousArtifactVersion: row.version,
      nextArtifactVersion,
      bodyBlocks,
      previousBodyBlocks: (row.body_blocks ?? null) as ArtifactBodyBlocksT | null,
      historyAfter: history as ArtifactHistoryEntryT[],
      actorKind: 'user',
      actorRef,
      createdAt: now,
      optOutMemoryIngestion: false,
    });

    if (projectionIsWriter('artifact') && wasEventSourced) {
      // ON (W3-D flip) — the projection write-through becomes the SOLE row writer; the imperative
      // UPDATE is skipped. The read-time `row.version !== expectedArtifactVersion` check above already
      // rejected a stale write (the 409 optimistic guard for the common case); the narrow lost-update
      // window left without the UPDATE's version-guarded `.returning()` matches the W2 goal posture
      // (projectGoalGuarded also has no row-level version guard). projectArtifactGuarded re-folds the
      // create/genesis base + every edit (incl. the one just emitted) and upserts the row.
      await projectArtifactGuarded(tx, params.artifactId);
    } else {
      const updated = await tx
        .update(artifact)
        .set({
          body_blocks: bodyBlocks as never,
          history: history as never,
          updated_at: now,
          version: nextArtifactVersion,
        })
        .where(
          and(
            eq(artifact.id, params.artifactId),
            eq(artifact.version, params.expectedArtifactVersion),
          ),
        )
        .returning({ version: artifact.version });
      if (updated.length === 0) {
        throw new ApiError('conflict', `artifact ${params.artifactId} concurrently modified`, 409);
      }
      // OFF — assert fold == the row the imperative UPDATE just wrote (only when the artifact is
      // event-sourced; a pre-W3 row folds to null and would false-mismatch). dev/test THROW, prod warn.
      if (wasEventSourced) {
        const [written] = await tx
          .select()
          .from(artifact)
          .where(eq(artifact.id, params.artifactId))
          .limit(1);
        await assertArtifactParity(
          tx,
          params.artifactId,
          written ? artifactLiveRowToSnapshot(written) : null,
        );
      }
    }

    // YUK-95 P5: keep the L2 cross_link backlink index in sync within the same tx (both paths wrote
    // the same AFTER body_blocks, so this runs once after the branch).
    await syncBlockRefsForArtifact(tx, params.artifactId, bodyBlocks);

    return {
      artifact_id: params.artifactId,
      artifact_version: nextArtifactVersion,
      body_blocks: bodyBlocks,
      event_id: eventId,
    };
  });
}
