// YUK-1548 §2.2 — the one renderer for the generative-UI block family: every Markdown surface hands
// a `tlp-block` fence body here (through MarkdownRenderer), and this switches on `kind`. Kinds in
// the union that no surface draws yet, and anything the schema rejects, get one quiet line.
// v2 grows this into a recursive view over block trees; callers keep passing a fence body.

import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { type BlockV1T, parseBlockFence } from '@/core/schema/blocks';
import { BlockUnavailable } from './BlockFrame';
import { DiagramBlock } from './DiagramBlock';
import { FigureBlock } from './FigureBlock';

export function BlockView({ block }: { block: BlockV1T | undefined }): ReactElement {
  if (!block) return <BlockUnavailable />;
  switch (block.kind) {
    case 'diagram':
      return <DiagramBlock block={block} />;
    case 'figure':
      return <FigureBlock block={block} />;
    default:
      return <BlockUnavailable alt={block.alt} />;
  }
}

/** A stored fence body (the JSON between the backticks) → its block view. */
export function BlockFenceView({ body }: { body: string }): ReactElement {
  const block = useMemo(() => parseBlockFence(body), [body]);
  return <BlockView block={block} />;
}
