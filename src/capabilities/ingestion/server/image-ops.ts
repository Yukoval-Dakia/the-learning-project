import sharp from 'sharp';

import type { BBoxT } from '@/core/schema/structured_question';

// Pure image primitives shared by the pipeline crop path and the agent media
// tools. Pixel math clamps extraction boxes; rotation normalizes EXIF orientation.

export interface PixelBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageProbe {
  width: number;
  height: number;
  format: string | undefined;
}

export async function probeImage(bytes: Uint8Array): Promise<ImageProbe | null> {
  try {
    const meta = await sharp(Buffer.from(bytes)).metadata();
    if (!meta.width || !meta.height) return null;
    return { width: meta.width, height: meta.height, format: meta.format };
  } catch {
    return null;
  }
}

/**
 * Clamp a pixel bbox into the image. Independent rounding / OCR output can put
 * a box one pixel past an edge; degenerate results return null instead of a
 * fabricated crop.
 */
export function clampPixelBBox(
  bbox: PixelBBox,
  image: { width: number; height: number },
): PixelBBox | null {
  const x = Math.min(image.width - 1, Math.max(0, Math.round(bbox.x)));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(bbox.y)));
  const width = Math.min(image.width - x, Math.round(bbox.width));
  const height = Math.min(image.height - y, Math.round(bbox.height));
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Normalized [0,1] bbox → pixel bbox for a w×h image. */
export function normalizedToPixel(
  bbox: BBoxT,
  image: { width: number; height: number },
): PixelBBox {
  return {
    x: bbox.x * image.width,
    y: bbox.y * image.height,
    width: bbox.width * image.width,
    height: bbox.height * image.height,
  };
}

/**
 * Crop to PNG bytes. Returns null when the clamped box is empty.
 */
export async function cropToPng(
  bytes: Uint8Array,
  bbox: PixelBBox,
): Promise<{ png: Uint8Array; bbox: PixelBBox } | null> {
  const probe = await probeImage(bytes);
  if (!probe) throw new Error('image-ops: could not read image dimensions');
  const clamped = clampPixelBBox(bbox, probe);
  if (!clamped) return null;
  const png = await sharp(Buffer.from(bytes))
    .extract({ left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height })
    .png()
    .toBuffer();
  return {
    png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
    bbox: clamped,
  };
}

export type RotateDegrees = 90 | 180 | 270;

export interface RotateResult {
  bytes: Uint8Array;
  mime: 'image/png';
  width: number;
  height: number;
  /** 'auto' resolved via EXIF orientation; explicit degrees applied as given. */
  applied: 'exif_normalized' | `rotated_${RotateDegrees}`;
}

/**
 * Rotate an image. `degrees` = 90/180/270 clockwise, or 'auto' to normalize
 * EXIF orientation (sharp's bare `.rotate()`). Output is always PNG — a
 * canonical derived encoding so derived assets compare byte-stable.
 */
export async function rotateImage(
  bytes: Uint8Array,
  degrees: RotateDegrees | 'auto',
): Promise<RotateResult> {
  const pipeline = sharp(Buffer.from(bytes));
  const rotated = degrees === 'auto' ? pipeline.rotate() : pipeline.rotate(degrees);
  const png = await rotated.png().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  return {
    bytes: out,
    mime: 'image/png',
    width: png.info.width,
    height: png.info.height,
    applied: degrees === 'auto' ? 'exif_normalized' : `rotated_${degrees}`,
  };
}

/**
 * Down-scale for a model-facing view only — the stored asset is never touched.
 * Returns the original bytes when already within maxEdge or the format can't
 * be resized into a web-safe mime.
 */
export async function resizeForView(
  bytes: Uint8Array,
  mimeType: string,
  maxEdge: number,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const probe = await probeImage(bytes);
  if (!probe || Math.max(probe.width, probe.height) <= maxEdge) {
    return { bytes, mimeType };
  }
  const format =
    probe.format === 'jpeg' || probe.format === 'png' || probe.format === 'webp'
      ? probe.format
      : 'png';
  const resized = await sharp(Buffer.from(bytes))
    .resize({
      width: probe.width >= probe.height ? maxEdge : undefined,
      height: probe.height > probe.width ? maxEdge : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toFormat(format)
    .toBuffer();
  return {
    bytes: new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength),
    mimeType: `image/${format}`,
  };
}
