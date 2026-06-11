import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  bodyBlocksToNoteSections,
  replaceNoteSectionBody,
} from '@/capabilities/notes/server/body-blocks';
import { ArtifactBodyBlocks, type NoteSection } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';

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
  const now = params.now ?? new Date();
  const eventId = params.eventId ?? createId();
  const actorRef = params.actorRef ?? 'learning_item_detail';

  return params.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifact.id,
        body_blocks: artifact.body_blocks,
        history: artifact.history,
        archived_at: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, params.artifactId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError('not_found', `artifact ${params.artifactId} not found`, 404);
    }
    if (row.archived_at) {
      throw new ApiError('conflict', `artifact ${params.artifactId} is archived`, 409);
    }
    if (row.version !== params.expectedArtifactVersion) {
      throw new ApiError('conflict', `artifact ${params.artifactId} concurrently modified`, 409);
    }

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

    const nextSection: NoteSectionT = {
      ...previous,
      body_md: params.nextBodyMd,
      version: previous.version + 1,
    };
    const nextArtifactVersion = row.version + 1;
    const payload = {
      artifact_id: params.artifactId,
      block_id: params.sectionId,
      block_index: sectionIndex,
      previous_body_md: previous.body_md,
      next_body_md: params.nextBodyMd,
      previous_version: previous.version,
      next_version: nextSection.version,
    };
    const history = Array.isArray(row.history) ? [...row.history] : [];
    history.push({
      version: nextArtifactVersion,
      at: now,
      by: { by: 'user' },
      summary_md: `Edited block ${params.sectionId}`,
      action: 'block_edit',
      event_id: eventId,
      previous_artifact_version: row.version,
      next_artifact_version: nextArtifactVersion,
      ...payload,
    });

    const updated = await tx
      .update(artifact)
      .set({
        body_blocks: replaceNoteSectionBody(
          row.body_blocks,
          params.sectionId,
          params.nextBodyMd,
        ) as never,
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
      action: 'experimental:artifact_section_edit',
      subject_kind: 'artifact',
      subject_id: params.artifactId,
      outcome: 'success',
      payload,
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    return {
      artifact_id: params.artifactId,
      artifact_version: nextArtifactVersion,
      section: nextSection,
      event_id: eventId,
    };
  });
}
