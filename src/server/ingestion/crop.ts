import sharp from 'sharp';

import type { BBoxT } from '@/core/schema/structured_question';
import type { R2Client } from '@/server/r2';

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
};

/**
 * Sharp 按 normalized BBox 裁剪每张 figure，PNG 编码上传 R2，返回 PreAttachFigure[]。
 *
 * 并行 Promise.all 加速；R2 失败抛错由调用方决定是否 retry（pg-boss 层做）。
 */
export async function cropAndUploadFigures(args: CropArgs): Promise<PreAttachFigure[]> {
  if (args.figureBoxes.length === 0) return [];

  const meta = await sharp(args.pageImage).metadata();
  const pixelW = meta.width;
  const pixelH = meta.height;
  if (!pixelW || !pixelH) {
    throw new Error('cropAndUploadFigures: sharp could not determine page image dimensions');
  }

  return await Promise.all(
    args.figureBoxes.map(async (bbox, idx) => {
      const left = Math.max(0, Math.round(bbox.x * pixelW));
      const top = Math.max(0, Math.round(bbox.y * pixelH));
      const width = Math.max(1, Math.round(bbox.width * pixelW));
      const height = Math.max(1, Math.round(bbox.height * pixelH));

      const cropped = await sharp(args.pageImage)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();

      // asset_id 与 R2 key 命名约定：可读、便于排查（pageAssetId + figure idx）
      const assetId = `${args.pageAssetId}-fig-${idx}`;
      const key = `figures/${assetId}.png`;
      await args.r2.put(key, new Uint8Array(cropped), 'image/png');

      return {
        asset_id: assetId,
        role: 'diagram' as const,
        source_page_index: args.pageIndex,
        source_bbox: bbox,
      };
    }),
  );
}
