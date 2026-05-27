import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';

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
        history: artifact.history,
        archived_at: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, params.artifactId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
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

    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: 'experimental:artifact_body_blocks_edit',
      subject_kind: 'artifact',
      subject_id: params.artifactId,
      outcome: 'success',
      payload: {
        artifact_id: params.artifactId,
        previous_version: row.version,
        next_version: nextArtifactVersion,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    return {
      artifact_id: params.artifactId,
      artifact_version: nextArtifactVersion,
      body_blocks: bodyBlocks,
      event_id: eventId,
    };
  });
}
