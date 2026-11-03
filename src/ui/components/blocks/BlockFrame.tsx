// YUK-1548 — the card every drawn block sits in, and the two quiet states it can fall back to.
// Cards are paper with a hairline and no shadow (T3); a figure's card stays paper-white in both
// themes because an <img> cannot follow CSS variables (§3.2).

import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import './blocks.css';

export interface BlockFrameProps {
  kind: string;
  caption?: string;
  /** Busy while the picture is still being drawn or fetched. */
  busy?: boolean;
  children: ReactNode;
}

export function BlockFrame({ kind, caption, busy, children }: BlockFrameProps): ReactElement {
  return (
    <figure className="un-blk" data-kind={kind} aria-busy={busy || undefined}>
      {children}
      {caption ? <figcaption className="un-blk-caption">{caption}</figcaption> : null}
    </figure>
  );
}

/** Before the picture is ready the card holds its place and says what it will show. */
export function BlockPlaceholder({ alt }: { alt: string }): ReactElement {
  return (
    <div className="un-blk-canvas un-blk-canvas-wait">
      <p className="un-blk-wait-alt">{alt}</p>
    </div>
  );
}

/**
 * The picture could not be shown: say what it was, say it plainly, and keep the source readable
 * as text. The source is only ever printed, never run.
 */
export function BlockFailure({
  alt,
  source,
  sourceLabel = '查看图的原文',
}: {
  alt: string;
  source?: string;
  sourceLabel?: string;
}): ReactElement {
  return (
    <div className="un-blk-canvas un-blk-canvas-failed">
      <p className="un-blk-failed-alt">{alt}</p>
      <p className="un-blk-failed-note">图无法显示</p>
      {source ? (
        <details className="un-blk-source">
          <summary className="un-hit">{sourceLabel}</summary>
          <pre>
            <code>{source}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/** Anything the block schema rejects, or a kind this surface cannot show yet: one muted line. */
export function BlockUnavailable({ alt }: { alt?: string }): ReactElement {
  return (
    <p className="un-blk-quiet">
      {alt ? `「${alt}」暂时显示不了。` : '这里有一张图，暂时显示不了。'}
    </p>
  );
}

/** Visually hidden long description, read through aria-describedby. */
export function useLongDescription(text: string | undefined): {
  id: string | undefined;
  node: ReactElement | null;
} {
  const id = useId();
  if (!text) return { id: undefined, node: null };
  return {
    id,
    node: (
      <span id={id} className="un-blk-sr">
        {text}
      </span>
    ),
  };
}
