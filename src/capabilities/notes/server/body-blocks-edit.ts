import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { ArtifactBodyBlocksT, ArtifactHistoryEntryT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { emitArtifactBodyBlocksEditEvent } from '@/server/artifacts/mutation-events';
import { ApiError } from '@/server/http/errors';

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

    // YUK-95 P5: keep the L2 cross_link backlink index in sync within the same tx.
    await syncBlockRefsForArtifact(tx, params.artifactId, bodyBlocks);

    // YUK-471 W3-C1γ — migrate off the body-LESS `experimental:artifact_body_blocks_edit` onto the
    // A1 self-sufficient `experimental:body_blocks_edit` carrying the full AFTER body_blocks +
    // previous (for revert) + after-history + version, so foldArtifact reproduces the row VERBATIM
    // (additive double-write; projection flag OFF). Same tx — a malformed payload rolls back the
    // paired UPDATE (parseEvent barrier). The event id stays = eventId (the value pinned into the
    // history entry above). optOutMemoryIngestion:false preserves the OLD edit event's outbox
    // behaviour (a hand edit IS a user activity — byte-preserve the prior ingest_at=NULL).
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

    return {
      artifact_id: params.artifactId,
      artifact_version: nextArtifactVersion,
      body_blocks: bodyBlocks,
      event_id: eventId,
    };
  });
}
