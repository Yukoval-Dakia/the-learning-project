// YUK-1548 §2.2 — the one display primitive for drawn blocks. A diagram's rendered SVG and a
// figure's sanitised asset both reach the page only as an <img>: an image never runs script and
// never reaches the network, so no markup from a model ever becomes live DOM (§3.2).

import type { ReactElement } from 'react';

export interface SvgImageProps {
  /** A data: or blob: URL whose bytes are image/svg+xml. */
  src: string;
  alt: string;
  /** Intrinsic size from the SVG viewBox, when known: reserves the box before the bytes decode. */
  width?: number;
  height?: number;
  /** Id of the visually hidden long description. */
  describedBy?: string;
  /** Keep labels readable on a narrow column: shrink at most to this share, then scroll. */
  minScale?: number;
}

export function SvgImage({
  src,
  alt,
  width,
  height,
  describedBy,
  minScale = 0.6,
}: SvgImageProps): ReactElement {
  const floor = width ? Math.round(width * minScale) : undefined;
  return (
    <img
      className="un-blk-img"
      src={src}
      alt={alt}
      width={width}
      height={height}
      aria-describedby={describedBy}
      decoding="async"
      draggable={false}
      style={floor ? { minWidth: `${floor}px` } : undefined}
    />
  );
}
