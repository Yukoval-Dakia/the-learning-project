import { eq } from 'drizzle-orm';
import sharp from 'sharp';

import type { BBoxT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';

import { clampPixelBBox, normalizedToPixel, probeImage } from './image-ops';
import {
  type SourceAssetRow,
  isUniqueViolation,
  lockImageStorageKey,
  sha256Hex,
} from './persist-image-asset';

/**
 * 单张题目图（"figure"）裁剪后的元信息——未挂归属。 attach_confidence /
 * attached_to_index 由后续 assignFigures 填。
 */
export type PreAttachFigure = {
  asset_id: string;
  role: 'diagram';
  source_page_index: number;
  source_bbox: BBoxT;
};

export type CropArgs = {
  pageImage: Buffer;
  pageAssetId: string;
  pageIndex: number;
  figureBoxes: BBoxT[];
  r2: R2Client;
  db: Db;
};

// YUK-1404 (B2/R3+R11) — pipeline crops are now REGISTERED source assets.
//
// Previously this only wrote `figures/<page>-fig-N.png` to object storage: no
// source_asset row, no SHA. That missing registration is exactly why
// serving-admission withheld every photo-cropped figure (figure_attach's
// public check requires a row whose storage_key matches the figures/ key and
// whose sha256 is a real content hash).
//
// The row keeps the deterministic id/key convention (`<pageAssetId>-fig-<N>` /
// `figures/<id>.png`) so the existing figure_attach check passes unchanged and
// re-runs are naturally idempotent: a same-shape row is re-served, a drifted
// one fails loudly. Derivation lineage lands in provenance
// (derived_from + op.crop{bbox_norm, bbox_px}) — same provenance shape the
// crop_image agent tool writes for its content-addressed derived assets.

const FIGURE_ID_RE = /^[a-z0-9]+-fig-\d+$/i;

async function persistFigureCrop(
  db: Db,
  r2: R2Client,
  input: {
    id: string;
    png: Uint8Array;
    pageAssetId: string;
    pageSha256: string;
    pageIndex: number;
    bboxNorm: BBoxT;
    bboxPx: { x: number; y: number; width: number; height: number };
  },
): Promise<SourceAssetRow> {
  const sha = await sha256Hex(input.png);
  const storageKey = `figures/${input.id}.png`;
  const provenance = {
    role: 'pipeline_figure',
    page_index: input.pageIndex,
    derived_from: { asset_id: input.pageAssetId, digest: `sha256:${input.pageSha256}` },
    op: {
      kind: 'crop' as const,
      bbox_norm: input.bboxNorm,
      bbox_px: input.bboxPx,
    },
  };

  // A prior pass may already have registered this deterministic id, and
  // concurrent extractions may be writing different bytes under the same
  // `<page>-fig-N` identity. The unlocked existence check is racy (Codex
  // 4292929371): the loser can put its bytes over the winner's object before
  // its duplicate-id insert fails, leaving the winning row pointing at bytes
  // with a different SHA. So ALL decisions — re-read, adopt, update, insert —
  // happen AFTER acquiring the storage-key advisory lock, and the
  // compensating oldBytes snapshot is taken under the same lock (round-2
  // P2-1) so a restore can never write stale bytes.
  const dims = await probeImage(input.png);
  let oldBytes: Uint8Array | null = null;
  let overwroteObject = false;
  try {
    return await db.transaction(async (tx) => {
      await lockImageStorageKey(tx, storageKey);
      const [existing] = await tx
        .select()
        .from(source_asset)
        .where(eq(source_asset.id, input.id))
        .limit(1);
      if (existing) {
        if (existing.storage_key !== storageKey) {
          throw new Error(
            `figure asset '${input.id}' exists under key '${existing.storage_key}', expected '${storageKey}'`,
          );
        }
        if (existing.sha256 === sha) return existing;
        // Same id, different content = the session was retried after OCR
        // produced different boxes: the pre-registration path simply
        // overwrote the figures/ object, so we keep that overwrite — now
        // registered. Row update BEFORE put: a put failure rolls the row
        // back, so the registered sha can never drift from the served bytes.
        // A post-put commit failure restores oldBytes below.
        oldBytes = await r2.get(storageKey);
        overwroteObject = true;
        const [updated] = await tx
          .update(source_asset)
          .set({
            mime_type: 'image/png',
            byte_size: input.png.byteLength,
            sha256: sha,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            provenance,
          })
          .where(eq(source_asset.id, input.id))
          .returning();
        await r2.put(storageKey, input.png, 'image/png');
        return updated;
      }
      // First writer under this key — same protocol as persistSourceAsset:
      // snapshot whether another row already owns the object before putting,
      // so a failed insert only deletes bytes nobody owns.
      const hadOwnerBeforePut =
        (
          await tx
            .select({ id: source_asset.id })
            .from(source_asset)
            .where(eq(source_asset.storage_key, storageKey))
            .limit(1)
        ).length > 0;
      await r2.put(storageKey, input.png, 'image/png');
      try {
        const [inserted] = await tx
          .insert(source_asset)
          .values({
            id: input.id,
            kind: 'image',
            storage_key: storageKey,
            mime_type: 'image/png',
            byte_size: input.png.byteLength,
            sha256: sha,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            provenance,
            created_at: new Date(),
          })
          .returning();
        if (!inserted) {
          throw new Error('persistFigureCrop: INSERT ... RETURNING returned no row');
        }
        return inserted;
      } catch (err) {
        if (!hadOwnerBeforePut) {
          try {
            await r2.delete(storageKey);
          } catch (cleanupErr) {
            console.error('[persistFigureCrop] failed to compensate R2 put:', cleanupErr);
          }
        }
        throw err;
      }
    });
  } catch (err) {
    if (overwroteObject && oldBytes) {
      await r2.put(storageKey, oldBytes, 'image/png').catch(() => {});
    }
    // A writer outside this lock (different storage key, same id) can still
    // race the insert — re-read and adopt only on identical registered
    // content. postgres.js wraps the 23505, so walk the cause chain rather
    // than matching message text.
    if (isUniqueViolation(err)) {
      const [row] = await db
        .select()
        .from(source_asset)
        .where(eq(source_asset.id, input.id))
        .limit(1);
      if (row && row.storage_key === storageKey && row.sha256 === sha) return row;
    }
    throw err;
  }
}

/**
 * Sharp 按 normalized BBox 裁剪每张 figure，PNG 编码并登记为 source_asset 行
 * （figures/<page>-fig-N.png 约定保留，figure_attach 的公开性检查不变），
 * 返回 PreAttachFigure[]。
 *
 * R2/DB 失败抛错由调用方决定是否 retry（pg-boss 层做）；重试幂等——同一
 * (pageAssetId, idx) 产出的确定性行幂等复用。
 */
export async function cropAndUploadFigures(args: CropArgs): Promise<PreAttachFigure[]> {
  if (args.figureBoxes.length === 0) return [];

  const pageMeta = await sharp(args.pageImage).metadata();
  const pixelW = pageMeta.width;
  const pixelH = pageMeta.height;
  if (!pixelW || !pixelH) {
    throw new Error('cropAndUploadFigures: sharp could not determine page image dimensions');
  }

  const [pageRow] = await args.db
    .select({ sha256: source_asset.sha256 })
    .from(source_asset)
    .where(eq(source_asset.id, args.pageAssetId))
    .limit(1);
  if (!pageRow) {
    throw new Error(
      `cropAndUploadFigures: page asset '${args.pageAssetId}' is not a registered source_asset — derived crops need a registered parent`,
    );
  }

  const figures = await Promise.all(
    args.figureBoxes.map(async (bbox, idx) => {
      // OCR can clamp an off-page box to zero area. Keep its original index
      // reserved instead of fabricating a pixel or renumbering later crops.
      if (bbox.width <= 0 || bbox.height <= 0) return null;

      const pixel = clampPixelBBox(normalizedToPixel(bbox, { width: pixelW, height: pixelH }), {
        width: pixelW,
        height: pixelH,
      });
      if (!pixel) return null;

      const cropped = await sharp(args.pageImage)
        .extract({ left: pixel.x, top: pixel.y, width: pixel.width, height: pixel.height })
        .png()
        .toBuffer();

      const assetId = `${args.pageAssetId}-fig-${idx}`;
      if (!FIGURE_ID_RE.test(assetId)) {
        throw new Error(`cropAndUploadFigures: derived figure id '${assetId}' is malformed`);
      }
      await persistFigureCrop(args.db, args.r2, {
        id: assetId,
        png: new Uint8Array(cropped.buffer, cropped.byteOffset, cropped.byteLength),
        pageAssetId: args.pageAssetId,
        pageSha256: pageRow.sha256,
        pageIndex: args.pageIndex,
        bboxNorm: bbox,
        bboxPx: pixel,
      });

      return {
        asset_id: assetId,
        role: 'diagram' as const,
        source_page_index: args.pageIndex,
        source_bbox: bbox,
      };
    }),
  );
  return figures.filter((figure) => figure !== null);
}
