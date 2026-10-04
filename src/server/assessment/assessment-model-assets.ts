import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  ModelExecutorRequest,
  PendingStateT,
  VersionedAssetRefT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import {
  containsRenderedImage,
  hasInlineQuestionImage,
} from '@/server/assessment/jev-model-executor';

export interface AssessmentAssetBytes {
  bytes: Uint8Array;
  mime_type: string;
}
export type AssessmentAssetLoader = (
  ref: VersionedAssetRefT,
  signal: AbortSignal,
) => Promise<AssessmentAssetBytes | null>;

export function createAssessmentAssetLoader(db: Db): AssessmentAssetLoader {
  return async (ref, signal) => {
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, ref.asset_id))
      .limit(1);
    if (!row || `sha256:${row.sha256}` !== ref.digest) return null;
    const { getR2 } = await import('@/server/r2');
    signal.throwIfAborted();
    const bytes = await getR2().get(row.storage_key);
    signal.throwIfAborted();
    if (!bytes || bytes.length !== row.byte_size) return null;
    return { bytes, mime_type: row.mime_type };
  };
}

/** Race only against cancellation; always detach the listener on settlement. */
export async function withinAssessmentSignal<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export type AssessmentModelInput = {
  text: string;
  images: Array<{ data: string; mediaType: string }>;
};

export async function prepareAssessmentModelInput(
  request: ModelExecutorRequest,
  load: AssessmentAssetLoader,
  signal: AbortSignal,
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
  const images: AssessmentModelInput['images'] = [];
  const imageManifest: Array<{
    index: number;
    material_id?: string;
    evidence_id?: string;
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
    identity: { material_id?: string; evidence_id?: string },
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
    if (!asset || !attach(asset, material.asset, { material_id: material.material_id })) {
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
        materials: request.materials,
        image_manifest: imageManifest,
        text_evidence: textEvidence,
      }),
      images,
    },
  };
}
