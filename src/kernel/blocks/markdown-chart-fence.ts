// A note write has no tool-result binding step, so a `tlp-block` chart that
// claims recorded data would render 来自记录 over model numbers. The write seam
// rewrites such a fence to model data before the reader can see it.

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { ChartBlockT } from '@/core/schema/blocks/block';
import {
  TLP_BLOCK_FENCE_INFO,
  canonicalBlockJson,
  parseBlockFence,
} from '@/core/schema/blocks/fence';

interface MarkdownNode {
  type?: string;
  lang?: string | null;
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MarkdownNode[];
}

const parser = unified().use(remarkParse);

/**
 * Rewrite one fence body when it is a chart claiming recorded data. Returns null
 * for everything else, so a normal fence keeps its exact bytes. A tool_result
 * caption belongs to the record (bindChartSeries replaces it), so it is dropped.
 */
export function downgradeUnboundChartFenceBody(body: string): string | null {
  const block = parseBlockFence(body);
  if (block?.kind !== 'chart' || block.data_source.kind !== 'tool_result') return null;
  const { caption: _caption, ...rest } = block;
  return canonicalBlockJson({ ...rest, data_source: { kind: 'model' } } satisfies ChartBlockT);
}

function rewriteFence(raw: string, value: string): string | null {
  const downgraded = downgradeUnboundChartFenceBody(value);
  if (downgraded === null) return null;
  const firstBreak = raw.indexOf('\n');
  if (firstBreak < 0) return null;
  const openLine = raw.slice(0, firstBreak);
  const rest = raw.slice(firstBreak + 1);
  const lastBreak = rest.lastIndexOf('\n');
  const lastLine = lastBreak >= 0 ? rest.slice(lastBreak + 1) : rest;
  // The closing line carries the container prefix (blockquote marker or list
  // indentation); every rewritten body line needs the same one to stay inside it.
  const closing = /^([ \t>]*)(?:`{3,}|~{3,})[ \t]*\r?$/.exec(lastLine);
  const bodyText = closing ? (lastBreak >= 0 ? rest.slice(0, lastBreak) : '') : rest;
  const continuation = closing?.[1] ?? /^([ \t>]*)/.exec(bodyText.split('\n')[0] ?? '')?.[1] ?? '';
  const payload = downgraded
    .split('\n')
    .map((line) => `${continuation}${line}`)
    .join('\n');
  return `${openLine}\n${payload}${closing ? `\n${lastLine}` : ''}`;
}

/**
 * Rewrite a chart fence stored as a `codeBlock` inside a note body or patch,
 * so the block content and the reader mirror agree after a model write.
 */
export function downgradeUnboundChartFencesInBlockTree<T>(value: T): T {
  const clone = structuredClone(value);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === 'codeBlock') {
      const attrs = record.attrs;
      const languageValue =
        attrs !== null && typeof attrs === 'object'
          ? (attrs as Record<string, unknown>).language
          : undefined;
      const language = typeof languageValue === 'string' ? languageValue.split(/\s+/)[0] : '';
      if (language === TLP_BLOCK_FENCE_INFO && Array.isArray(record.content)) {
        for (const child of record.content) {
          if (child === null || typeof child !== 'object') continue;
          const textNode = child as Record<string, unknown>;
          if (textNode.type !== 'text' || typeof textNode.text !== 'string') continue;
          const downgraded = downgradeUnboundChartFenceBody(textNode.text);
          if (downgraded !== null) textNode.text = downgraded;
        }
      }
    }
    if (Array.isArray(record.content)) visit(record.content);
  };
  visit(clone);
  return clone;
}

function collectCodeNodes(node: MarkdownNode, found: MarkdownNode[]): void {
  if (node.type === 'code') found.push(node);
  for (const child of node.children ?? []) collectCodeNodes(child, found);
}

/** Downgrade every unbound recorded-data chart fence, leaving all other bytes as written. */
export function downgradeUnboundChartFences(markdown: string): string {
  if (!markdown.includes(TLP_BLOCK_FENCE_INFO)) return markdown;
  let tree: MarkdownNode;
  try {
    tree = parser.parse(markdown) as unknown as MarkdownNode;
  } catch {
    return markdown;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const codeNodes: MarkdownNode[] = [];
  collectCodeNodes(tree, codeNodes);
  for (const node of codeNodes) {
    if (node.lang !== TLP_BLOCK_FENCE_INFO) continue;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const replacement = rewriteFence(markdown.slice(start, end), node.value ?? '');
    if (replacement !== null) edits.push({ start, end, text: replacement });
  }
  if (edits.length === 0) return markdown;
  edits.sort((a, b) => b.start - a.start);
  let output = markdown;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return output;
}
