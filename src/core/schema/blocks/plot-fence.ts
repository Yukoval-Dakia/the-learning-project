// Question-material guard for `plot` fences: a frozen question may carry a
// static plot, but never learner-adjustable params. Question materials are
// raw Markdown, so the block schema alone cannot enforce the surface rule;
// this scanner runs at draft conversion (and therefore on save, validate and
// submit) before any learner-facing page can render a fence.
//
// The scan mirrors the renderer's Markdown semantics instead of a regex: the
// renderer resolves fences through remark, where `tlp\-block`, `tlp&#45;block`,
// `~~~` fences, `\r`-only line endings and a BOM before the body all still
// produce a `tlp-block` code block. A regex that only sees the literal
// ```tlp-block spelling is therefore bypassable by exactly those forms.

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { TLP_BLOCK_FENCE_INFO, parseBlockFence } from './fence';

interface MarkdownNode {
  readonly type?: string;
  readonly lang?: string | null;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
}

const parser = unified().use(remarkParse);

function collectCodeNodes(node: MarkdownNode, found: MarkdownNode[]): void {
  if (node.type === 'code') found.push(node);
  for (const child of node.children ?? []) collectCodeNodes(child, found);
}

/**
 * Return the 1-based indexes of plot fences that declare params, counted over
 * `tlp-block` fences in document order (including ones whose body is not a
 * readable block, matching the previous scanner's numbering). Malformed fence
 * bodies are not param fences: the renderer falls back to quiet text for them.
 */
export function findPlotParamFences(markdown: string): number[] {
  let tree: MarkdownNode;
  try {
    tree = parser.parse(markdown) as unknown as MarkdownNode;
  } catch {
    // micromark is total over string input; keep the guard total anyway.
    return [];
  }
  const codeNodes: MarkdownNode[] = [];
  collectCodeNodes(tree, codeNodes);
  const found: number[] = [];
  let fenceIndex = 0;
  for (const node of codeNodes) {
    // `node.lang` is the decoded first info word — the same value the
    // renderer turns into `language-<lang>` before BlockFenceView sees it.
    if (node.lang !== TLP_BLOCK_FENCE_INFO) continue;
    fenceIndex += 1;
    // The renderer trims the body before parsing, so a BOM or Unicode
    // padding must not hide a plot fence from this guard either.
    const block = parseBlockFence((node.value ?? '').trim());
    if (block?.kind === 'plot' && (block.params?.length ?? 0) > 0) {
      found.push(fenceIndex);
    }
  }
  return found;
}
