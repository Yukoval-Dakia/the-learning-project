/** Numeric bbox shape before or after canonical normalization. */
export interface BBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clamp one normalized coordinate to [0, 1]; non-finite inputs normalize to zero. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Clamp a normalized bbox component-wise and cap its size at the remaining page extent.
 * The result is canonical and sum-safe: x + width <= 1 and y + height <= 1.
 */
export function clampBBox(bbox: BBoxLike): BBoxLike {
  const x = clamp01(bbox.x);
  const y = clamp01(bbox.y);
  return {
    x,
    y,
    width: Math.min(clamp01(bbox.width), 1 - x),
    height: Math.min(clamp01(bbox.height), 1 - y),
  };
}
