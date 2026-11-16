import { createHash } from 'node:crypto';
import {
  containsRenderedImage,
  hasInlineQuestionImage,
} from '@/capabilities/practice/grading/server/jev-model-executor';
import type {
  ModelExecutorRequest,
  PendingStateT,
  VersionedAssetRefT,
} from '@/core/schema/assessment';
import type { LearnerHandwritingMarkerT } from '@/core/schema/assessment/materials';
import type { Db } from '@/db/client';
import { readFigureMaterialMarkers } from '@/kernel/read-models/figure-origin';
import {
  type AssessmentAssetBytes,
  type AssessmentAssetLoader,
  createAssessmentAssetLoader as createAssetLoader,
  withinAssessmentSignal,
} from '@/kernel/records/assessment-assets';

export {
  type AssessmentAssetBytes,
  type AssessmentAssetLoader,
  withinAssessmentSignal,
} from '@/kernel/records/assessment-assets';

export function createAssessmentAssetLoader(db: Db): AssessmentAssetLoader {
  return createAssetLoader(db, async (key) => {
    const { getR2 } = await import('@/kernel/object-storage');
    return getR2().get(key);
  });
}

export type AssessmentModelInput = {
  text: string;
  images: Array<{ data: string; mediaType: string }>;
};

/** 单次判分调用可携带的提交图片证据上限（张数 / 总字节）。 */
const DIRECT_JUDGE_IMAGE_LIMIT = 8;
const DIRECT_JUDGE_IMAGE_BYTES_LIMIT = 32 * 1024 * 1024;

export async function prepareAssessmentModelInput(
  request: ModelExecutorRequest,
  load: AssessmentAssetLoader,
  signal: AbortSignal,
  db: Db,
): Promise<{ ok: true; input: AssessmentModelInput } | { ok: false; pending: PendingStateT }> {
  const hold = (detail: string) => ({
    ok: false as const,
    pending: { reason: 'unjudgeable' as const, detail },
  });
  if (hasInlineQuestionImage(request))
    return hold('inline question image has no frozen asset binding');
  const criterion = request.unit.criterion;
  const ruleText =
    criterion.kind === 'rule_reference'
      ? [criterion.statement_md]
      : criterion.kind === 'holistic_level'
        ? criterion.levels.map((level) => level.descriptor_md)
        : [];
  const answerText = request.slot_responses.flatMap((entry) =>
    entry.kind === 'text' || entry.kind === 'open' ? [entry.text_md ?? ''] : [],
  );
  if ([...ruleText, ...answerText].some(containsRenderedImage))
    return hold('rule or submitted text contains an unbound original image');
  // A question figure may show the learner's earlier work; the judge must know which.
  const figureMarkers = await readFigureMaterialMarkers(db, request.materials);
  const materials = request.materials.map((material) =>
    figureMarkers.has(material.material_id)
      ? { ...material, contains_learner_handwriting: figureMarkers.get(material.material_id) }
      : material,
  );
  const images: AssessmentModelInput['images'] = [];
  const imageManifest: Array<{
    index: number;
    material_id?: string;
    evidence_id?: string;
    contains_learner_handwriting?: LearnerHandwritingMarkerT;
    asset: VersionedAssetRefT;
  }> = [];
  const textEvidence: Array<{ evidence_id: string; text: string }> = [];
  const digest = (bytes: Uint8Array | string) =>
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const read = async (ref: VersionedAssetRefT) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(ref.digest)) return null;
    const asset = await withinAssessmentSignal(() => load(ref, signal), signal);
    return asset && digest(asset.bytes) === ref.digest ? asset : null;
  };
  const attach = (
    asset: AssessmentAssetBytes,
    ref: VersionedAssetRefT,
    identity: {
      material_id?: string;
      evidence_id?: string;
      contains_learner_handwriting?: LearnerHandwritingMarkerT;
    },
  ) => {
    // pi's image wire supports these MIME types; audio/video/PDF are held below.
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mime_type))
      return false;
    imageManifest.push({ index: images.length, ...identity, asset: ref });
    images.push({ data: Buffer.from(asset.bytes).toString('base64'), mediaType: asset.mime_type });
    return true;
  };
  for (const material of request.materials) {
    signal.throwIfAborted();
    if (['plaintext', 'passage', 'table'].includes(material.kind)) {
      if (
        material.content_md === undefined ||
        digest(material.content_md) !== material.asset.digest ||
        containsRenderedImage(material.content_md)
      ) {
        return {
          ok: false,
          pending: { reason: 'missing_materials', material_ids: [material.material_id] },
        };
      }
      continue;
    }
    if (material.kind !== 'figure')
      return hold(`original ${material.kind} analysis is not supported by this executor`);
    const asset = await read(material.asset);
    if (
      !asset ||
      !attach(asset, material.asset, {
        material_id: material.material_id,
        contains_learner_handwriting: figureMarkers.get(material.material_id),
      })
    ) {
      return {
        ok: false,
        pending: { reason: 'missing_materials', material_ids: [material.material_id] },
      };
    }
  }
  const evidence = [
    ...request.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
    ...request.group_evidence.map((item) => item.evidence),
  ];
  // 直接多模态判把每张图都发 provider：张数与字节是单次付费调用的费用与
  // 滥用边界（8 张/32MB）。超限不静默裁减 ——
  // 整个单元明确 unjudgeable。
  const imageEvidence = evidence.filter((item) => item.kind === 'image');
  if (imageEvidence.length > DIRECT_JUDGE_IMAGE_LIMIT) {
    return hold(
      `image evidence count ${imageEvidence.length} exceeds the direct-judging limit of ${DIRECT_JUDGE_IMAGE_LIMIT}`,
    );
  }
  const imageBytes = imageEvidence.reduce((total, item) => total + item.bytes, 0);
  if (imageBytes > DIRECT_JUDGE_IMAGE_BYTES_LIMIT) {
    return hold(
      `image evidence is ${imageBytes} bytes, over the direct-judging limit of ${DIRECT_JUDGE_IMAGE_BYTES_LIMIT}`,
    );
  }
  for (const item of evidence) {
    signal.throwIfAborted();
    if (item.kind !== 'image' && item.kind !== 'plaintext')
      return hold(`original ${item.kind} evidence analysis is not supported by this executor`);
    const asset = await read(item.asset);
    if (!asset || asset.bytes.length !== item.bytes || asset.mime_type !== item.mime_type) {
      return {
        ok: false,
        pending: {
          reason: 'unreadable_evidence',
          evidence_ids: [item.evidence_id],
          detail: 'original asset missing or frozen bytes/MIME/digest mismatch',
        },
      };
    }
    if (item.kind === 'image') {
      if (!attach(asset, item.asset, { evidence_id: item.evidence_id }))
        return hold('unsupported image MIME');
    } else {
      if (!asset.mime_type.startsWith('text/'))
        return hold('plaintext evidence has a non-text MIME');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
      } catch {
        return {
          ok: false,
          pending: {
            reason: 'unreadable_evidence',
            evidence_ids: [item.evidence_id],
            detail: 'plaintext is not valid UTF-8',
          },
        };
      }
      if (containsRenderedImage(text))
        return hold('plaintext evidence contains an unbound original image');
      textEvidence.push({ evidence_id: item.evidence_id, text });
    }
  }
  signal.throwIfAborted();
  return {
    ok: true,
    input: {
      text: JSON.stringify({
        submission_id: request.submission_id,
        submission_ids: request.submission_ids ?? [request.submission_id],
        evaluation_group_id: request.evaluation_group_id,
        revision_id: request.revision_id,
        scoring_unit: request.unit,
        ...(request.review_context ? { review_context: request.review_context } : {}),
        question_parts: request.question_parts,
        response_slots: request.response_slots,
        slot_responses: request.slot_responses,
        group_evidence: request.group_evidence,
        materials,
        image_manifest: imageManifest,
        text_evidence: textEvidence,
      }),
      images,
    },
  };
}
