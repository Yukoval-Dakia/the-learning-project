import { createHash } from 'node:crypto';
import Markdown from 'react-markdown';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import type { assessment_issuance, question_revision } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  type AssessmentAssetLoader,
  withinAssessmentSignal,
} from '@/kernel/records/assessment-assets';
import {
  loadIssuanceStudyCoordinate,
  projectFrozenStudyReference,
} from '@/kernel/records/study-reference';
import { recordAssistanceExposure } from './assistance';
import { issuanceRowToContract, revisionRowToContract } from './issue';

/** Teaching sees exactly the issued face and published marking for its scope. */
export async function loadFrozenStudyContext(
  database: Db,
  issuanceId: string,
  questionId?: string,
) {
  const loaded = await loadIssuanceStudyCoordinate(database, issuanceId, questionId);
  switch (loaded.status) {
    case 'not_found':
      throw new ApiError('not_found', 'issued assessment not found', 404);
    case 'coordinate_mismatch':
      throw new ApiError('coordinate_mismatch', 'question is outside the frozen issuance', 409);
    case 'reveal_unavailable':
      throw new ApiError(
        'reveal_unavailable',
        'this assessment does not permit study assistance',
        409,
      );
    case 'assistable':
      return projectFrozenStudyContext(loaded.revision, loaded.issuance, questionId);
  }
}

/** Pure frozen projection; callers enforce their own disclosure boundary. */
export function projectFrozenStudyContext(
  row: typeof question_revision.$inferSelect,
  issuance: typeof assessment_issuance.$inferSelect,
  questionId?: string,
) {
  const revision = revisionRowToContract(row);
  const projected = projectFrozenStudyReference(revision, issuanceRowToContract(issuance));
  return {
    question_id: questionId ?? row.group_id,
    // Teaching needs the complete served controls/material metadata, not just prose.
    practice_dto: projected.practiceDto,
    public_materials: revision.structure.materials.filter((material) =>
      projected.practiceDto.materials.some(
        (publicMaterial) => publicMaterial.material_id === material.material_id,
      ),
    ),
    prompt_md: projected.promptMd,
    reference_md: projected.referenceMd,
    solution_md: projected.solutionMd,
  };
}

export async function revealFrozenStudyReference(database: Db, issuanceId: string) {
  const context = await loadFrozenStudyContext(database, issuanceId);
  if (context.reference_md)
    await recordAssistanceExposure(database, {
      issuanceId,
      questionId: context.question_id,
      kind: 'solution',
      impact: 'answer_help',
      contentDigest: `sha256:${canonicalHash(context.reference_md)}`,
    });
  return { reference_md: context.reference_md };
}

/** Only issued public figure bindings authorize byte reads, including Markdown images. */
export async function loadFrozenStudyImages(
  context: ReturnType<typeof projectFrozenStudyContext>,
  load: AssessmentAssetLoader,
  signal: AbortSignal,
) {
  const unavailable = () =>
    new ApiError(
      'study_media_unavailable',
      'required frozen study media is missing, unsupported or unbound',
      409,
    );
  const figures = context.public_materials.filter((material) => material.kind === 'figure');
  const trustedUrls = new Set(
    figures.map((material) => `/api/assets/${encodeURIComponent(material.asset.asset_id)}/content`),
  );
  // Parse strings separately so CommonMark reference definitions retain their line breaks.
  const checkImages = (value: unknown): void => {
    if (typeof value === 'string') {
      Markdown({
        children: value,
        allowElement(element) {
          if (element.tagName === 'img' && !trustedUrls.has(String(element.properties.src)))
            throw unavailable();
          return true;
        },
      });
    } else if (Array.isArray(value)) {
      for (const item of value) checkImages(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) checkImages(item);
    }
  };
  checkImages(context.practice_dto);
  checkImages(context.reference_md);
  const digest = (value: string | Uint8Array) =>
    `sha256:${createHash('sha256').update(value).digest('hex')}`;
  // Validate the whole requirement before loading any bytes or calling a model.
  for (const material of context.public_materials) {
    if (material.kind === 'figure') {
      if (!/^sha256:[0-9a-f]{64}$/.test(material.asset.digest)) throw unavailable();
    } else if (
      !['plaintext', 'passage', 'table'].includes(material.kind) ||
      material.content_md === undefined ||
      digest(material.content_md) !== material.asset.digest
    ) {
      throw unavailable();
    }
  }
  const images: Array<{ data: string; mediaType: string }> = [];
  const image_manifest: Array<{ index: number; material_id: string; asset_id: string }> = [];
  try {
    for (const material of figures) {
      const asset = await withinAssessmentSignal(() => load(material.asset, signal), signal);
      if (
        !asset ||
        digest(asset.bytes) !== material.asset.digest ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mime_type)
      )
        throw unavailable();
      image_manifest.push({
        index: images.length,
        material_id: material.material_id,
        asset_id: material.asset.asset_id,
      });
      images.push({
        data: Buffer.from(asset.bytes).toString('base64'),
        mediaType: asset.mime_type,
      });
    }
    signal.throwIfAborted();
  } catch {
    throw unavailable();
  }
  return { images, image_manifest };
}
