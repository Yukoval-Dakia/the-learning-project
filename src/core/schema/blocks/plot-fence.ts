// Question-material guard for `plot` fences: a frozen question may carry a
// static plot, but never learner-adjustable params. Question materials are
// raw Markdown, so the block schema alone cannot enforce the surface rule;
// this scanner runs at draft conversion (and therefore on save, validate and
// submit) before any learner-facing page can render a fence.

import { parseBlockFence } from './fence';

const BLOCK_FENCE_RE = /```tlp-block[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Return the 1-based indexes of plot fences that declare params. Malformed
 * fences are ignored here: they cannot be parsed into a renderable block, and
 * the renderer already falls back to quiet text.
 */
export function findPlotParamFences(markdown: string): number[] {
  const found: number[] = [];
  const pattern = new RegExp(BLOCK_FENCE_RE.source, BLOCK_FENCE_RE.flags);
  let match = pattern.exec(markdown);
  let fenceIndex = 0;
  while (match !== null) {
    fenceIndex += 1;
    const block = parseBlockFence(match[1]);
    if (block?.kind === 'plot' && (block.params?.length ?? 0) > 0) {
      found.push(fenceIndex);
    }
    match = pattern.exec(markdown);
  }
  return found;
}
