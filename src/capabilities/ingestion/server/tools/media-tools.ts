import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { RetryableError } from '@/core/schema/structured_question';
import { source_asset } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { TOOL_OUTPUT_IMAGES_FIELD } from '@/kernel/tools/types';
import { createDirectProviderOperationContext } from '@/server/ai/provider-attempt-runtime';
import { runGlmLayoutParsingWithAttempt } from '../glm_ocr';
import { type PixelBBox, cropToPng, probeImage, rotateImage } from '../image-ops';
import { type SourceAssetRow, persistSourceAsset } from '../persist-image-asset';
import { GLM_OCR_MODEL, GLM_OCR_PROVIDER } from '../provider-attempts';
import { formatAssetRef } from '../source-package';
import {
  AssetRefInputSchema,
  PixelBBoxInputSchema,
  assertAssetInScope,
  findOwningDocument,
  getR2,
  loadVerifiedAssetBytes,
  requireAssetRef,
} from './source-tool-support';
import type { DomainTool } from './types';

// YUK-1404 (B2/R2–R5) — the four shared media tools. One tool per capability,
// declared in manifest.ts, allowlisted for the ingestion surface only.
//
// Every image the model sees flows through the media bridge: the tool's OUTPUT
// carries `images: [{ref:{asset_id,digest:'sha256:<64hex>'}, max_edge?}]` — the
// bridge loads bytes through the digest-verifying loader and appends real
// ImageContent; logs/events persist only the refs.

const DEFAULT_VIEW_MAX_EDGE = 1600;

const VersionedDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i, 'digest must be sha256:<64 hex>');

const AssetRefOutputSchema = z.object({
  asset_id: z.string(),
  digest: VersionedDigestSchema,
  ref: z.string(),
});

const ImageDeclarationSchema = z.object({
  ref: z.object({ asset_id: z.string(), digest: VersionedDigestSchema }),
  max_edge: z.number().int().positive().optional(),
});

function assetRefOutput(row: Pick<SourceAssetRow, 'id' | 'sha256'>): {
  asset_id: string;
  digest: string;
  ref: string;
} {
  return {
    asset_id: row.id,
    digest: `sha256:${row.sha256}`,
    ref: formatAssetRef(row.id, row.sha256),
  };
}

/** derived asset id: deterministic over (parent digest, op, args, request_id). */
function derivedAssetId(parentSha: string, op: string, args: string, requestId?: string): string {
  const sha = createHash('sha256')
    .update(`${parentSha}|${op}|${args}|${requestId ?? ''}`)
    .digest('hex')
    .slice(0, 24);
  return `der_${sha}`;
}

/** Adopt an existing same-content derived row (idempotent replay). */
async function persistDerivedImage(
  ctx: ToolContext,
  input: {
    bytes: Uint8Array;
    id: string;
    provenance: Record<string, unknown>;
  },
): Promise<SourceAssetRow> {
  const [existing] = await ctx.db
    .select()
    .from(source_asset)
    .where(eq(source_asset.id, input.id))
    .limit(1);
  if (existing) {
    const newSha = createHash('sha256').update(input.bytes).digest('hex');
    if (existing.sha256 !== newSha) {
      throw new Error(
        `derived asset '${input.id}' exists with different content — request collision, choose a new request_id`,
      );
    }
    return existing;
  }
  return persistSourceAsset(ctx.db, getR2(), {
    bytes: input.bytes,
    mime: 'image/png',
    kind: 'image',
    id: input.id,
    provenance: input.provenance,
    compensatePutOnInsertFailure: true,
  });
}

// ---------------------------------------------------------------- view_image

const ViewImageInputSchema = z.object({
  /** ast1:<asset_id>:<sha12> or {asset_id, digest:'sha256:<hex>'}. */
  ref: AssetRefInputSchema,
  /** Optional long-edge px cap for the returned view (view only — the stored
   * asset is never mutated). Default 1600, hard ceiling applied by the bridge. */
  max_edge: z.number().int().positive().max(2048).optional(),
});
type ViewImageInput = z.infer<typeof ViewImageInputSchema>;

const ViewImageOutputSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  reason: z.string().nullable(),
  asset: z
    .object({
      asset_id: z.string(),
      digest: VersionedDigestSchema,
      ref: z.string(),
      mime: z.string(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      byte_size: z.number().int(),
    })
    .nullable(),
  [TOOL_OUTPUT_IMAGES_FIELD]: z.array(ImageDeclarationSchema),
});
type ViewImageOutput = z.infer<typeof ViewImageOutputSchema>;

async function executeViewImage(ctx: ToolContext, raw: ViewImageInput): Promise<ViewImageOutput> {
  const input = ViewImageInputSchema.parse(raw);
  const row = await requireAssetRef(ctx, input.ref);
  await assertAssetInScope(ctx, row.id);
  if (!row.mime_type.startsWith('image/')) {
    return {
      status: 'unavailable',
      reason: `asset is ${row.mime_type}, not an image`,
      asset: null,
      images: [],
    };
  }
  return {
    status: 'ok',
    reason: null,
    asset: {
      ...assetRefOutput(row),
      mime: row.mime_type,
      width: row.width,
      height: row.height,
      byte_size: row.byte_size,
    },
    images: [
      {
        ref: { asset_id: row.id, digest: `sha256:${row.sha256}` },
        max_edge: input.max_edge ?? DEFAULT_VIEW_MAX_EDGE,
      },
    ],
  };
}

export const viewImageTool: DomainTool<ViewImageInput, ViewImageOutput> = {
  name: 'view_image',
  description:
    'View an image asset. Takes a versioned ref (ast1:<asset_id>:<sha12> or {asset_id,digest}) and returns real image bytes to the model; digest mismatch or an out-of-scope asset fails explicitly. max_edge down-scales the returned view only.',
  effect: 'read',
  inputSchema: ViewImageInputSchema,
  outputSchema: ViewImageOutputSchema,
  costClass: 'local',
  execute: executeViewImage,
  summarize: (_input, output) => `view_image ${output.status} ${output.asset?.asset_id ?? ''}`,
  mirrorEvent: 'when_user_visible',
};

// ---------------------------------------------------------------- crop_image

const CropImageInputSchema = z.object({
  ref: AssetRefInputSchema,
  /** Pixel bbox on the REFERENCED image version (x, y = top-left). */
  bbox: PixelBBoxInputSchema,
  /** Idempotency key from the caller; same request_id replays to the same
   * derived asset. */
  request_id: z.string().min(1).max(120).optional(),
});
type CropImageInput = z.infer<typeof CropImageInputSchema>;

const CropImageOutputSchema = z.object({
  status: z.enum(['ok', 'unavailable', 'failed']),
  reason: z.string().nullable(),
  parent: AssetRefOutputSchema.nullable(),
  derived: AssetRefOutputSchema.extend({
    mime: z.literal('image/png'),
    width: z.number().int(),
    height: z.number().int(),
  }).nullable(),
  /** The pixel bbox that actually ran, after clamping to the parent image. */
  bbox_px: PixelBBoxInputSchema.nullable(),
  /** The image version all coordinates in this result belong to — bboxes for
   * the derived image are in its coordinate space, not the parent's. */
  coordinate_space: z
    .object({
      asset_id: z.string(),
      digest: VersionedDigestSchema,
      role: z.enum(['parent', 'derived']),
    })
    .nullable(),
  [TOOL_OUTPUT_IMAGES_FIELD]: z.array(ImageDeclarationSchema),
});
type CropImageOutput = z.infer<typeof CropImageOutputSchema>;

async function executeCropImage(ctx: ToolContext, raw: CropImageInput): Promise<CropImageOutput> {
  const input = CropImageInputSchema.parse(raw);
  const parent = await requireAssetRef(ctx, input.ref);
  await assertAssetInScope(ctx, parent.id);
  if (!parent.mime_type.startsWith('image/')) {
    return {
      status: 'unavailable',
      reason: `asset is ${parent.mime_type}, not an image`,
      parent: assetRefOutput(parent),
      derived: null,
      bbox_px: null,
      coordinate_space: null,
      images: [],
    };
  }

  const bytes = await loadVerifiedAssetBytes(getR2(), parent);
  const cropped = await cropToPng(bytes, input.bbox);
  if (!cropped) {
    return {
      status: 'failed',
      reason: 'empty_crop: bbox covers no pixels of the referenced image',
      parent: assetRefOutput(parent),
      derived: null,
      bbox_px: null,
      coordinate_space: null,
      images: [],
    };
  }

  const id = derivedAssetId(
    parent.sha256,
    'crop',
    `${input.bbox.x},${input.bbox.y},${input.bbox.width},${input.bbox.height}`,
    input.request_id,
  );
  const parentProv = parent.provenance as Record<string, unknown> | null;
  const derived = await persistDerivedImage(ctx, {
    bytes: cropped.png,
    id,
    provenance: {
      role: 'derived_crop',
      derived_from: { asset_id: parent.id, digest: `sha256:${parent.sha256}` },
      op: { kind: 'crop', bbox_px: cropped.bbox, requested_bbox_px: input.bbox },
      coordinate_space: { asset_id: id },
      derivation_request: input.request_id ?? null,
      ...(typeof parentProv?.page_index === 'number' ? { page_index: parentProv.page_index } : {}),
    },
  });

  const probe = await probeImage(cropped.png);
  const derivedRef = assetRefOutput(derived);
  return {
    status: 'ok',
    reason: null,
    parent: assetRefOutput(parent),
    derived: {
      ...derivedRef,
      mime: 'image/png',
      width: probe?.width ?? cropped.bbox.width,
      height: probe?.height ?? cropped.bbox.height,
    },
    bbox_px: cropped.bbox,
    coordinate_space: {
      asset_id: derived.id,
      digest: `sha256:${derived.sha256}`,
      role: 'derived',
    },
    images: [{ ref: { asset_id: derived.id, digest: `sha256:${derived.sha256}` } }],
  };
}

export const cropImageTool: DomainTool<CropImageInput, CropImageOutput> = {
  name: 'crop_image',
  description:
    'Crop an image asset by pixel bbox (x,y = top-left, on the referenced image version). Mints a NEW registered source_asset — the original is never modified — carrying parent ref+digest, the bbox, and its own sha256. Idempotent by request_id. The result is returned to the model as image content.',
  effect: 'write',
  inputSchema: CropImageInputSchema,
  outputSchema: CropImageOutputSchema,
  costClass: 'local',
  execute: executeCropImage,
  summarize: (input, output) =>
    `crop_image ${output.status} ${output.derived?.asset_id ?? 'none'} bbox=${input.bbox.x},${input.bbox.y},${input.bbox.width}x${input.bbox.height}`,
  mirrorEvent: 'when_user_visible',
};

// ---------------------------------------------------------------- rotate_image

const RotateImageInputSchema = z.object({
  ref: AssetRefInputSchema,
  /** 90/180/270 clockwise, or 'auto' to normalize EXIF orientation. */
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal('auto')]),
  request_id: z.string().min(1).max(120).optional(),
});
type RotateImageInput = z.infer<typeof RotateImageInputSchema>;

const RotateImageOutputSchema = z.object({
  status: z.enum(['ok', 'unavailable', 'failed']),
  reason: z.string().nullable(),
  parent: AssetRefOutputSchema.nullable(),
  derived: AssetRefOutputSchema.extend({
    mime: z.literal('image/png'),
    width: z.number().int(),
    height: z.number().int(),
  }).nullable(),
  applied: z.enum(['exif_normalized', 'rotated_90', 'rotated_180', 'rotated_270']).nullable(),
  /** Derived-image coordinate space: bboxes measured post-rotation belong to
   * this version, NOT the parent. */
  coordinate_space: z
    .object({
      asset_id: z.string(),
      digest: VersionedDigestSchema,
      role: z.enum(['parent', 'derived']),
    })
    .nullable(),
  [TOOL_OUTPUT_IMAGES_FIELD]: z.array(ImageDeclarationSchema),
});
type RotateImageOutput = z.infer<typeof RotateImageOutputSchema>;

async function executeRotateImage(
  ctx: ToolContext,
  raw: RotateImageInput,
): Promise<RotateImageOutput> {
  const input = RotateImageInputSchema.parse(raw);
  const parent = await requireAssetRef(ctx, input.ref);
  await assertAssetInScope(ctx, parent.id);
  if (!parent.mime_type.startsWith('image/')) {
    return {
      status: 'unavailable',
      reason: `asset is ${parent.mime_type}, not an image`,
      parent: assetRefOutput(parent),
      derived: null,
      applied: null,
      coordinate_space: null,
      images: [],
    };
  }

  const bytes = await loadVerifiedAssetBytes(getR2(), parent);
  let rotated: Awaited<ReturnType<typeof rotateImage>>;
  try {
    rotated = await rotateImage(bytes, input.degrees);
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      parent: assetRefOutput(parent),
      derived: null,
      applied: null,
      coordinate_space: null,
      images: [],
    };
  }

  const id = derivedAssetId(
    parent.sha256,
    'rotate',
    `${input.degrees}:${rotated.applied}`,
    input.request_id,
  );
  const parentProv = parent.provenance as Record<string, unknown> | null;
  const derived = await persistDerivedImage(ctx, {
    bytes: rotated.bytes,
    id,
    provenance: {
      role: 'derived_rotate',
      derived_from: { asset_id: parent.id, digest: `sha256:${parent.sha256}` },
      op: { kind: 'rotate', requested: input.degrees, applied: rotated.applied },
      coordinate_space: { asset_id: id },
      derivation_request: input.request_id ?? null,
      ...(typeof parentProv?.page_index === 'number' ? { page_index: parentProv.page_index } : {}),
    },
  });

  const derivedRef = assetRefOutput(derived);
  return {
    status: 'ok',
    reason: null,
    parent: assetRefOutput(parent),
    derived: {
      ...derivedRef,
      mime: 'image/png',
      width: rotated.width,
      height: rotated.height,
    },
    applied: rotated.applied,
    coordinate_space: {
      asset_id: derived.id,
      digest: `sha256:${derived.sha256}`,
      role: 'derived',
    },
    images: [{ ref: { asset_id: derived.id, digest: `sha256:${derived.sha256}` } }],
  };
}

export const rotateImageTool: DomainTool<RotateImageInput, RotateImageOutput> = {
  name: 'rotate_image',
  description:
    "Rotate an image asset by 90/180/270 clockwise, or normalize EXIF orientation with degrees='auto'. Mints a NEW registered source_asset (the original is never modified) whose provenance carries the transform and whose digest defines the new coordinate space — bboxes measured after rotation refer to the derived version. Idempotent by request_id.",
  effect: 'write',
  inputSchema: RotateImageInputSchema,
  outputSchema: RotateImageOutputSchema,
  costClass: 'local',
  execute: executeRotateImage,
  summarize: (input, output) =>
    `rotate_image ${output.status} ${input.degrees} → ${output.derived?.asset_id ?? 'none'}`,
  mirrorEvent: 'when_user_visible',
};

// ---------------------------------------------------------------- glm_ocr

const GlmOcrInputSchema = z.object({
  ref: AssetRefInputSchema,
  /** Optional pixel region on the referenced image — cropped in memory for the
   * OCR request (the stored asset is never mutated). */
  region: PixelBBoxInputSchema.optional(),
});
type GlmOcrInput = z.infer<typeof GlmOcrInputSchema>;

const GlmOcrBlockSchema = z.object({
  label: z.string().nullable(),
  native_label: z.string().nullable(),
  bbox_px: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  text: z.string(),
});
type GlmOcrBlock = z.infer<typeof GlmOcrBlockSchema>;

const GlmOcrOutputSchema = z.object({
  status: z.enum(['completed', 'pending', 'failed']),
  /** Error detail / abort reason when failed. */
  reason: z.string().nullable(),
  retryable: z.boolean(),
  ocr: z
    .object({
      markdown: z.string(),
      blocks: z.array(GlmOcrBlockSchema),
    })
    .nullable(),
  /** What the OCR actually ran on: the source asset ref plus the applied
   * pixel region (or null = whole image). document_id/page_index locate the
   * anchor in the package when resolvable. */
  anchor: z
    .object({
      asset_id: z.string(),
      digest: VersionedDigestSchema,
      ref: z.string(),
      region_px: PixelBBoxInputSchema.nullable(),
      document_id: z.string().nullable(),
      page_index: z.number().int().nullable(),
    })
    .nullable(),
  /** provider_attempt identity — every other usage/cost claim joins to it. */
  run_ref: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  usage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  cost: z
    .object({ amount: z.number(), currency: z.literal('CNY'), basis: z.literal('estimated') })
    .nullable(),
  external_request_id: z.string().nullable(),
});
type GlmOcrOutput = z.infer<typeof GlmOcrOutputSchema>;

const GLM_TOOL_TIMEOUT_MS = 120_000;

async function executeGlmOcr(ctx: ToolContext, raw: GlmOcrInput): Promise<GlmOcrOutput> {
  const input = GlmOcrInputSchema.parse(raw);
  if (ctx.providerAttemptCaller === undefined) {
    throw new TypeError('glm_ocr requires the actual provider attempt caller');
  }
  if (ctx.providerSessionDeadlineAt === undefined) {
    throw new TypeError('glm_ocr requires a provider session deadline');
  }
  ctx.signal?.throwIfAborted();
  if (Date.now() >= ctx.providerSessionDeadlineAt) {
    throw new Error('hard_deadline_exceeded');
  }

  const base: Omit<GlmOcrOutput, 'status' | 'reason' | 'retryable'> = {
    ocr: null,
    anchor: null,
    run_ref: null,
    provider: GLM_OCR_PROVIDER,
    model: GLM_OCR_MODEL,
    usage: null,
    cost: null,
    external_request_id: null,
  };

  const parent = await requireAssetRef(ctx, input.ref);
  await assertAssetInScope(ctx, parent.id);
  if (!parent.mime_type.startsWith('image/')) {
    return {
      ...base,
      status: 'failed',
      reason: `asset is ${parent.mime_type}, not an image`,
      retryable: false,
      anchor: {
        ...assetRefOutput(parent),
        region_px: null,
        document_id: await findOwningDocument(ctx.db, parent.id),
        page_index: null,
      },
    };
  }

  const bytes = await loadVerifiedAssetBytes(getR2(), parent);
  let ocrBytes: Uint8Array = bytes;
  let appliedRegion: PixelBBox | null = null;
  if (input.region) {
    const cropped = await cropToPng(bytes, input.region);
    if (!cropped) {
      return {
        ...base,
        status: 'failed',
        reason: 'region covers no pixels of the referenced image',
        retryable: false,
        anchor: {
          ...assetRefOutput(parent),
          region_px: input.region,
          document_id: await findOwningDocument(ctx.db, parent.id),
          page_index: null,
        },
      };
    }
    ocrBytes = cropped.png;
    appliedRegion = cropped.bbox;
  }

  const parentProv = parent.provenance as Record<string, unknown> | null;
  const anchor = {
    ...assetRefOutput(parent),
    region_px: appliedRegion,
    document_id: await findOwningDocument(ctx.db, parent.id),
    page_index: typeof parentProv?.page_index === 'number' ? parentProv.page_index : null,
  };

  const timeoutMs = Math.min(
    GLM_TOOL_TIMEOUT_MS,
    Math.max(5_000, ctx.providerSessionDeadlineAt - Date.now()),
  );
  const providerAttempt = createDirectProviderOperationContext({
    db: ctx.db,
    caller: ctx.providerAttemptCaller,
    deadlineAt: new Date(Date.now() + timeoutMs),
    // Deterministic anchor: the same tool call retried maps to the same
    // provider_operation — the lifecycle, not a second mystery row.
    operationAnchor: `glm_ocr:${ctx.taskRunId}:${parent.sha256}:${appliedRegion ? `${appliedRegion.x},${appliedRegion.y},${appliedRegion.width},${appliedRegion.height}` : 'full'}`,
  });

  try {
    const { response, attemptId } = await runGlmLayoutParsingWithAttempt({
      imageBase64: Buffer.from(ocrBytes).toString('base64'),
      mediaType: appliedRegion ? 'image/png' : parent.mime_type,
      signal: ctx.signal,
      timeoutMs,
      providerAttempt,
    });
    const blocks: GlmOcrBlock[] = [];
    for (const page of response.layout_details ?? []) {
      for (const block of page ?? []) {
        blocks.push({
          label: block.label?.trim() || null,
          native_label: block.native_label?.trim() || null,
          bbox_px: block.bbox_2d ?? null,
          text: block.content?.trim() ?? '',
        });
      }
    }
    const usage = response.usage ?? null;
    return {
      ...base,
      status: 'completed',
      reason: null,
      retryable: false,
      ocr: { markdown: response.md_results, blocks },
      anchor,
      run_ref: attemptId,
      // Cost: the provider_attempt row is the single attempt-truth; here we
      // echo only what usage actually reported (published token price, basis
      // 'estimated'). Missing usage stays null — never 0, never faked.
      usage:
        usage !== null
          ? {
              input: usage.prompt_tokens,
              output: usage.completion_tokens,
              total: usage.total_tokens,
            }
          : null,
      cost:
        usage && typeof usage.total_tokens === 'number'
          ? { amount: (usage.total_tokens / 1_000_000) * 0.2, currency: 'CNY', basis: 'estimated' }
          : null,
      external_request_id: response.request_id ?? null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return {
      ...base,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      retryable: err instanceof RetryableError,
      anchor,
    };
  }
}

export const glmOcrTool: DomainTool<GlmOcrInput, GlmOcrOutput> = {
  name: 'glm_ocr',
  description:
    'OCR an image asset (or a pixel region of it) with GLM layout parsing. Paid call: requires a provider session deadline — missing config returns status=failed, never a silent fallback. Returns status (completed|failed), layout blocks with pixel bboxes + markdown, the page anchor, run_ref (provider_attempt id), usage and estimated cost; unknown cost stays unknown.',
  effect: 'write',
  inputSchema: GlmOcrInputSchema,
  outputSchema: GlmOcrOutputSchema,
  // Real GLM tokens per call.
  costClass: 'expensive_llm',
  execute: executeGlmOcr,
  summarize: (_input, output) =>
    `glm_ocr ${output.status} blocks=${output.ocr?.blocks.length ?? 0} run=${output.run_ref ?? 'none'}`,
  mirrorEvent: 'when_user_visible',
};
