// Pure text-anchor patch for note bodies: each anchor must match exactly once in
// the block text, and only the matched text run (plus the block's Markdown
// mirror, when it carries one) is edited — structure and marks survive. No IO:
// write-note.ts owns the transaction.

import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '@/core/schema/business';

export interface MarkdownAnchorEdit {
  anchor: string;
  replacement: string;
}

export type NoteMarkdownPatchFailure =
  | { code: 'invalid_body_blocks'; message: string }
  | { code: 'anchor_not_found'; anchor: string; scanned_blocks: number }
  | {
      code: 'anchor_ambiguous';
      anchor: string;
      matches: { block_id: string | null; count: number }[];
    }
  // The anchor is one run of the block's text nodes but not one run of its
  // Markdown mirror (formatting inside the match), so a string splice would
  // guess at marks.
  | { code: 'anchor_spans_runs'; anchor: string; block_id: string | null }
  // The block's Markdown mirror disagrees with the text nodes: it holds the
  // anchor 0 or 2+ times. Editing only one of the two copies would leave the
  // reader and the editor showing different text.
  | { code: 'anchor_mirror_mismatch'; anchor: string; block_id: string | null; count: number };

export type NoteMarkdownPatchResult =
  | {
      ok: true;
      body_blocks: ArtifactBodyBlocksT;
      /** Top-level blocks whose text changed, with their post-patch node. */
      touched: { block_id: string | null; block: Record<string, unknown> }[];
    }
  | { ok: false; failure: NoteMarkdownPatchFailure };

type JsonNode = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function attrsOf(node: JsonNode): JsonNode {
  return isRecord(node.attrs) ? node.attrs : {};
}

function blockIdOf(node: JsonNode): string | null {
  const id = attrsOf(node).id;
  return typeof id === 'string' ? id : null;
}

// Text nodes in document order; the concatenation is the plain projection the
// model reads in section summaries (no markdown markers).
function collectTextNodes(node: JsonNode, out: JsonNode[]): void {
  if (typeof node.text === 'string') out.push(node);
  const content = Array.isArray(node.content) ? node.content : [];
  for (const child of content) if (isRecord(child)) collectTextNodes(child, out);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count += 1;
  return count;
}

function spliceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

interface BlockScan {
  index: number;
  id: string | null;
  runs: JsonNode[];
  text: string;
}

function scanBlocks(content: JsonNode[]): BlockScan[] {
  return content.map((node, index) => {
    const runs: JsonNode[] = [];
    collectTextNodes(node, runs);
    return {
      index,
      id: blockIdOf(node),
      runs,
      text: runs.map((run) => run.text as string).join(''),
    };
  });
}

/**
 * Applies every edit or none. Edits run in order against the body left by the
 * previous edit, so a later anchor may target earlier replacement text.
 */
export function applyMarkdownAnchorEdits(
  bodyBlocks: unknown,
  edits: readonly MarkdownAnchorEdit[],
): NoteMarkdownPatchResult {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_body_blocks',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      },
    };
  }

  const doc = structuredClone(parsed.data) as ArtifactBodyBlocksT;
  const content = (doc.content ?? []) as JsonNode[];
  // Top-level index -> its Markdown mirror after the edits applied so far.
  const mirrors = new Map<number, string>();
  const touched = new Set<number>();

  for (const edit of edits) {
    const scans = scanBlocks(content);
    const counts = scans.map((scan) => countOccurrences(scan.text, edit.anchor));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      return {
        ok: false,
        failure: { code: 'anchor_not_found', anchor: edit.anchor, scanned_blocks: scans.length },
      };
    }
    if (total > 1) {
      return {
        ok: false,
        failure: {
          code: 'anchor_ambiguous',
          anchor: edit.anchor,
          matches: scans
            .map((scan, i) => ({ block_id: scan.id, count: counts[i] }))
            .filter((match) => match.count > 0),
        },
      };
    }

    const scanIndex = counts.findIndex((count) => count > 0);
    const scan = scans[scanIndex];
    const node = content[scan.index];
    const mirror = mirrors.get(scan.index) ?? attrsOf(node).source_markdown;
    if (typeof mirror === 'string') {
      const mirrorCount = countOccurrences(mirror, edit.anchor);
      if (mirrorCount !== 1) {
        return {
          ok: false,
          failure: {
            code: 'anchor_mirror_mismatch',
            anchor: edit.anchor,
            block_id: scan.id,
            count: mirrorCount,
          },
        };
      }
    }

    const at = scan.text.indexOf(edit.anchor);
    let cursor = 0;
    let target: { run: JsonNode; start: number } | null = null;
    for (const run of scan.runs) {
      const text = run.text as string;
      if (at >= cursor && at + edit.anchor.length <= cursor + text.length) {
        target = { run, start: at - cursor };
        break;
      }
      cursor += text.length;
    }
    // The anchor crosses a formatting/line boundary; splitting the node would
    // guess at marks, so the whole call is refused.
    if (!target) {
      return {
        ok: false,
        failure: { code: 'anchor_spans_runs', anchor: edit.anchor, block_id: scan.id },
      };
    }

    const text = target.run.text as string;
    target.run.text =
      text.slice(0, target.start) +
      edit.replacement +
      text.slice(target.start + edit.anchor.length);
    if (typeof mirror === 'string') {
      mirrors.set(scan.index, spliceOnce(mirror, edit.anchor, edit.replacement));
    }
    touched.add(scan.index);
  }

  for (const index of touched) {
    const node = content[index];
    const attrs = attrsOf(node);
    const mirror = mirrors.get(index);
    content[index] = {
      ...node,
      attrs: {
        ...attrs,
        ...(mirror !== undefined ? { source_markdown: mirror } : {}),
        ...(typeof attrs.version === 'number' ? { version: attrs.version + 1 } : {}),
      },
    };
  }

  const result = ArtifactBodyBlocks.safeParse({ ...doc, content });
  if (!result.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_body_blocks',
        message: result.error.issues.map((issue) => issue.message).join('; '),
      },
    };
  }
  return {
    ok: true,
    body_blocks: result.data,
    touched: [...touched].map((index) => ({
      block_id: blockIdOf(content[index]),
      block: content[index],
    })),
  };
}
