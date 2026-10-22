import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import { emitArtifactBodyBlocksEditEvent } from '@/capabilities/notes/server/artifacts/mutation-events';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import type { ArtifactBodyBlocksT, ArtifactHistoryEntryT } from '@/core/schema/business';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { hasArtifactGenesisAnchor, projectArtifactGuarded } from '@/kernel/records/artifact-history';

// Block-tree editing is note-only. Opaque types (tool_quiz, interactive) must
// keep body_blocks null and never become mesh sources, so a hand-crafted PATCH
// cannot bypass the type guard.
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
        // The before body rides the fold event for revert; this SELECT already reads it.
        body_blocks: artifact.body_blocks,
        history: artifact.history,
        archived_at: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, params.artifactId))
      // Version check, projection, and backlink sync are one serialized edit.
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
    // Reject opaque types before writing: a block tree here would break their
    // invariant and turn the row into a mesh source.
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

    // Deployment owns legacy preparation; an edit must never fabricate its base.
    if (!(await hasArtifactGenesisAnchor(tx, params.artifactId))) {
      throw new Error(
        'canonical artifact edit requires complete history; run deployment migration',
      );
    }

    // Leave the user-activity outbox behaviour unchanged (ingest_at stays null).
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

    await projectArtifactGuarded(tx, params.artifactId);

    await syncBlockRefsForArtifact(tx, params.artifactId, bodyBlocks);

    return {
      artifact_id: params.artifactId,
      artifact_version: nextArtifactVersion,
      body_blocks: bodyBlocks,
      event_id: eventId,
    };
  });
}
