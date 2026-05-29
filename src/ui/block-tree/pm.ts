import { ArtifactBodyBlocks } from '@/core/schema/business';
import {
  ARTIFACT_REF_BLOCK_NODE,
  AUTO_LINKS_CONTAINER_NODE,
  type BlockTreeDoc,
  type BlockTreeNode,
  CALLOUT_BLOCK_NODE,
  CROSS_LINK_BLOCK_NODE,
  SEMANTIC_BLOCK_NODE,
  type SemanticBlockAttrs,
  type SemanticKind,
} from './types';

const DEFAULT_SOURCE_TIER = 'llm_only';

export function emptyBlockTreeDoc(): BlockTreeDoc {
  return { type: 'doc', content: [] };
}

export function textNode(text: string, marks?: BlockTreeNode['marks']): BlockTreeNode {
  return marks && marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
}

export function paragraphNode(text: string): BlockTreeNode {
  return { type: 'paragraph', content: text.length > 0 ? [textNode(text)] : [] };
}

export function semanticBlockNode(
  attrs: SemanticBlockAttrs,
  content: BlockTreeNode[] = [paragraphNode('')],
): BlockTreeNode {
  return {
    type: SEMANTIC_BLOCK_NODE,
    attrs: {
      source_tier: DEFAULT_SOURCE_TIER,
      user_verified: false,
      embedded_check: null,
      version: 0,
      ...attrs,
    },
    content,
  };
}

export function coerceBlockTreeDoc(value: unknown): BlockTreeDoc {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  return parsed.success ? parsed.data : emptyBlockTreeDoc();
}

export function nodeText(node: BlockTreeNode): string {
  if (typeof node.text === 'string') return node.text;
  const content = Array.isArray(node.content) ? node.content : [];
  return content.map((child) => nodeText(child)).join(node.type === 'paragraph' ? '' : '\n\n');
}

function withContent(doc: BlockTreeDoc, content: BlockTreeNode[]): BlockTreeDoc {
  return ArtifactBodyBlocks.parse({ ...doc, content });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function splitSemanticBlockAtText(
  doc: BlockTreeDoc,
  blockId: string,
  leftText: string,
  rightText: string,
  newBlockId: string,
): BlockTreeDoc {
  const content = [...(doc.content as BlockTreeNode[])];
  const index = content.findIndex(
    (node) => node.type === SEMANTIC_BLOCK_NODE && asRecord(node.attrs).id === blockId,
  );
  if (index < 0) return doc;

  const current = content[index];
  const attrs = asRecord(current.attrs) as unknown as SemanticBlockAttrs;
  const nextVersion = typeof attrs.version === 'number' ? attrs.version + 1 : 1;
  const left = semanticBlockNode({ ...attrs, id: blockId, version: nextVersion }, [
    paragraphNode(leftText),
  ]);
  const right = semanticBlockNode(
    {
      ...attrs,
      id: newBlockId,
      version: 0,
      derived_from_block_id: blockId,
    },
    [paragraphNode(rightText)],
  );
  content.splice(index, 1, left, right);
  return withContent(doc, content);
}

export function mergeAdjacentSemanticBlocks(
  doc: BlockTreeDoc,
  leftBlockId: string,
  rightBlockId: string,
): BlockTreeDoc {
  const content = [...(doc.content as BlockTreeNode[])];
  const leftIndex = content.findIndex(
    (node) => node.type === SEMANTIC_BLOCK_NODE && asRecord(node.attrs).id === leftBlockId,
  );
  const rightIndex = leftIndex + 1;
  const left = content[leftIndex];
  const right = content[rightIndex];
  if (
    leftIndex < 0 ||
    !right ||
    left?.type !== SEMANTIC_BLOCK_NODE ||
    right.type !== SEMANTIC_BLOCK_NODE ||
    asRecord(right.attrs).id !== rightBlockId
  ) {
    return doc;
  }

  const attrs = asRecord(left.attrs) as unknown as SemanticBlockAttrs;
  const nextVersion = typeof attrs.version === 'number' ? attrs.version + 1 : 1;
  const mergedText = [nodeText(left), nodeText(right)].filter(Boolean).join('\n\n');
  const merged = semanticBlockNode({ ...attrs, id: leftBlockId, version: nextVersion }, [
    paragraphNode(mergedText),
  ]);
  content.splice(leftIndex, 2, merged);
  return withContent(doc, content);
}

/**
 * Reorder a single top-level block from `fromIndex` to `toIndex`, leaving every
 * other block in place. This is the JSON-level contract that mirrors the
 * editor's ProseMirror-native node drag (YUK-150 P2-polish): reorder only moves
 * the *same* node — its `attrs` (including `attrs.id`) travel with it — so each
 * block's `block_id` is preserved (ADR-0022: "Block ids are stable semantic
 * anchors, not array indexes"; `mark_wrong` / cross_link projections stay
 * anchored). Out-of-range indices, or a no-op move, return the doc unchanged.
 */
export function reorderTopLevelBlock(
  doc: BlockTreeDoc,
  fromIndex: number,
  toIndex: number,
): BlockTreeDoc {
  const content = [...(doc.content as BlockTreeNode[])];
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= content.length ||
    toIndex >= content.length
  ) {
    return doc;
  }
  const [moved] = content.splice(fromIndex, 1);
  content.splice(toIndex, 0, moved);
  return withContent(doc, content);
}

export function markdownToBodyBlocks(markdown: string, idPrefix = 'paste'): BlockTreeDoc {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const kind: SemanticKind = index === 0 ? 'definition' : 'example';
      const plain = part
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*]\s+/gm, '')
        .replace(/`{1,3}/g, '')
        .trim();
      return semanticBlockNode(
        {
          id: `${idPrefix}_${index + 1}`,
          semantic_kind: kind,
        },
        [paragraphNode(plain)],
      );
    });
  return withContent(emptyBlockTreeDoc(), blocks);
}

export const BASIC_BLOCK_TREE_NODE_NAMES = [
  SEMANTIC_BLOCK_NODE,
  CROSS_LINK_BLOCK_NODE,
  ARTIFACT_REF_BLOCK_NODE,
  CALLOUT_BLOCK_NODE,
  AUTO_LINKS_CONTAINER_NODE,
] as const;
