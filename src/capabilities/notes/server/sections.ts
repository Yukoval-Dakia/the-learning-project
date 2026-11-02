import { createId } from '@paralleldrive/cuid2';
import type { z } from 'zod';

import { commitArtifactBody } from '@/capabilities/notes/server/artifact-body-commit';
import { replaceNoteSectionBody } from '@/capabilities/notes/server/body-blocks';
import {
  ArtifactBodyBlocks,
  type ArtifactBodyBlocksT,
  type NoteSection,
} from '@/core/schema/business';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { bodyBlocksToNoteSections } from '@/kernel/read-models/note-sections';

type NoteSectionT = z.infer<typeof NoteSection>;

export interface EditArtifactSectionParams {
  db: Db;
  artifactId: string;
  sectionId: string;
  expectedArtifactVersion: number;
  expectedSectionVersion: number;
  nextBodyMd: string;
  actorRef?: string;
  eventId?: string;
  now?: Date;
}

export interface EditArtifactSectionResult {
  artifact_id: string;
  artifact_version: number;
  section: NoteSectionT;
  event_id: string;
}

function parseSections(value: unknown, artifactId: string): NoteSectionT[] {
  if (value === null || value === undefined) {
    throw new ApiError('not_found', `artifact ${artifactId} has no sections`, 404);
  }
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      `artifact ${artifactId} body_blocks is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      500,
    );
  }
  return bodyBlocksToNoteSections(value);
}

export async function editArtifactSection(
  params: EditArtifactSectionParams,
): Promise<EditArtifactSectionResult> {
  const eventId = params.eventId ?? createId();
  const actorRef = params.actorRef ?? 'learning_item_detail';
  const concurrentlyModified = () =>
    new ApiError('conflict', `artifact ${params.artifactId} concurrently modified`, 409);

  return params.db.transaction(async (tx) => {
    let nextSection: NoteSectionT | undefined;
    const commit = await commitArtifactBody(tx, {
      artifactId: params.artifactId,
      requestedAt: params.now,
      plan: (row) => {
        if (row.archived_at) {
          throw new ApiError('conflict', `artifact ${params.artifactId} is archived`, 409);
        }
        if (row.version !== params.expectedArtifactVersion) throw concurrentlyModified();

        const sections = parseSections(row.body_blocks, params.artifactId);
        const sectionIndex = sections.findIndex((section) => section.id === params.sectionId);
        if (sectionIndex < 0) {
          throw new ApiError(
            'not_found',
            `section ${params.sectionId} not found on artifact ${params.artifactId}`,
            404,
          );
        }

        const previous = sections[sectionIndex];
        if (previous.version !== params.expectedSectionVersion) {
          throw new ApiError(
            'conflict',
            `section ${params.sectionId} concurrently modified on artifact ${params.artifactId}`,
            409,
          );
        }

        nextSection = {
          ...previous,
          body_md: params.nextBodyMd,
          version: previous.version + 1,
          // A human edit marks the section verified, so AI proposals cannot replace it.
          user_verified: true,
          source_tier: 'user_verified',
        };
        // A section edit is a full-body replace from the fold's point of view.
        const afterBody = replaceNoteSectionBody(
          row.body_blocks,
          params.sectionId,
          params.nextBodyMd,
        ) as ArtifactBodyBlocksT;
        return {
          body: afterBody,
          history: {
            by: { by: 'user' },
            summary_md: `Edited block ${params.sectionId}`,
            action: 'block_edit',
            fields: {
              event_id: eventId,
              artifact_id: params.artifactId,
              block_id: params.sectionId,
              block_index: sectionIndex,
              previous_body_md: previous.body_md,
              next_body_md: params.nextBodyMd,
              previous_version: previous.version,
              next_version: nextSection.version,
            },
          },
          actor: { kind: 'user', ref: actorRef },
          eventId,
          // Keep the section-edit outbox behaviour.
          optOutMemoryIngestion: false,
        };
      },
    });
    if (commit.status === 'missing') {
      throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
    }
    if (commit.status !== 'committed' || !nextSection) throw concurrentlyModified();

    return {
      artifact_id: params.artifactId,
      artifact_version: commit.version,
      section: nextSection,
      event_id: commit.eventId,
    };
  });
}
