import { createId } from '@paralleldrive/cuid2';

import { commitArtifactBody } from '@/capabilities/notes/server/artifact-body-commit';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { hasArtifactGenesisAnchor } from '@/kernel/records/artifact-history';

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
  const eventId = params.eventId ?? createId();
  const actorRef = params.actorRef ?? 'artifact_block_tree_editor';
  const bodyBlocks = ArtifactBodyBlocks.parse(params.bodyBlocks);
  const concurrentlyModified = () =>
    new ApiError('conflict', `artifact ${params.artifactId} concurrently modified`, 409);

  return params.db.transaction(async (tx) => {
    const commit = await commitArtifactBody(tx, {
      artifactId: params.artifactId,
      requestedAt: params.now,
      plan: async (row) => {
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
        if (row.version !== params.expectedArtifactVersion) throw concurrentlyModified();
        // Deployment owns legacy preparation; an edit must never fabricate its base.
        if (!(await hasArtifactGenesisAnchor(tx, params.artifactId))) {
          throw new Error(
            'canonical artifact edit requires complete history; run deployment migration',
          );
        }
        return {
          body: bodyBlocks,
          history: {
            by: { by: 'user' },
            summary_md: 'Edited block tree body',
            action: 'body_blocks_edit',
            fields: { event_id: eventId },
          },
          actor: { kind: 'user', ref: actorRef },
          eventId,
          // Leave the user-activity outbox behaviour unchanged (ingest_at stays null).
          optOutMemoryIngestion: false,
        };
      },
    });
    if (commit.status === 'missing') {
      throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
    }
    if (commit.status !== 'committed') throw concurrentlyModified();

    return {
      artifact_id: params.artifactId,
      artifact_version: commit.version,
      body_blocks: commit.body,
      event_id: commit.eventId,
    };
  });
}
