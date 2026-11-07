import type { z } from 'zod';

import { ArtifactBodyBlocks } from '@/core/schema/business';

type ArtifactBodyBlocksT = z.infer<typeof ArtifactBodyBlocks>;
interface ArtifactRefTarget {
  artifact_id: string;
  kind: string;
}
export interface ArtifactBlockSummary {
  id?: string;
  type: string;
  semantic_kind?: string;
  target?: ArtifactRefTarget;
  text_excerpt: string;
}

const SEMANTIC_BLOCK_TYPE = 'semanticBlock';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function blockText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text;
  const content = Array.isArray(node.content) ? node.content : [];
  const parts = content
    .filter(
      (child): child is Record<string, unknown> => child !== null && typeof child === 'object',
    )
    .map((child) => blockText(child));
  return parts.join(node.type === 'doc' || node.type === SEMANTIC_BLOCK_TYPE ? '\n\n' : '');
}

export function emptyArtifactBodyBlocks(): ArtifactBodyBlocksT {
  return { type: 'doc', content: [] };
}

export function bodyBlocksHaveSemanticKinds(
  value: unknown,
  requiredKinds: string[],
): { ok: boolean; missing: string[] } {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  const found = new Set<string>();

  if (parsed.success) {
    for (const node of parsed.data.content ?? []) {
      if (node.type !== SEMANTIC_BLOCK_TYPE) continue;
      const attrs = recordOrEmpty(node.attrs);
      if (typeof attrs.semantic_kind === 'string') found.add(attrs.semantic_kind);
    }
  }

  const missing = requiredKinds.filter((kind) => !found.has(kind));
  return { ok: missing.length === 0, missing };
}

/**
 * Last non-empty text line of a note body, trimmed; null when the document does
 * not parse or carries no text. Generation-time checks read how a note ends
 * without scanning (or rewriting) its whole prose.
 */
export function noteClosingLine(value: unknown): string | null {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return null;
  const nodes = parsed.data.content ?? [];
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === null || typeof node !== 'object') continue;
    const lines = blockText(node as Record<string, unknown>).split('\n');
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j]?.trim() ?? '';
      if (line.length > 0) return line;
    }
  }
  return null;
}

function artifactRefTarget(value: unknown): ArtifactRefTarget | undefined {
  const target = recordOrEmpty(value);
  return typeof target.artifact_id === 'string' && typeof target.kind === 'string'
    ? { artifact_id: target.artifact_id, kind: target.kind }
    : undefined;
}

function artifactRefTargetFromAttrs(attrs: Record<string, unknown>): ArtifactRefTarget | undefined {
  const nested = artifactRefTarget(attrs.target);
  if (nested) return nested;
  return typeof attrs.artifact_id === 'string' && typeof attrs.artifact_type === 'string'
    ? { artifact_id: attrs.artifact_id, kind: attrs.artifact_type }
    : undefined;
}

function textExcerpt(node: Record<string, unknown>, maxLength: number): string {
  const text = blockText(node).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

export function bodyBlocksToBlockSummaries(
  value: unknown,
  maxTextLength = 180,
): ArtifactBlockSummary[] {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return [];

  const summaries: ArtifactBlockSummary[] = [];
  const visit = (node: Record<string, unknown>) => {
    const attrs = recordOrEmpty(node.attrs);
    const target = artifactRefTargetFromAttrs(attrs);
    const id = typeof attrs.id === 'string' ? attrs.id : undefined;
    const semanticKind = typeof attrs.semantic_kind === 'string' ? attrs.semantic_kind : undefined;

    if (id || semanticKind || target) {
      summaries.push({
        ...(id ? { id } : {}),
        type: typeof node.type === 'string' ? node.type : 'unknown',
        ...(semanticKind ? { semantic_kind: semanticKind } : {}),
        ...(target ? { target } : {}),
        text_excerpt: textExcerpt(node, maxTextLength),
      });
    }

    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) {
      if (child !== null && typeof child === 'object') visit(child as Record<string, unknown>);
    }
  };

  for (const node of parsed.data.content ?? []) visit(node);
  return summaries;
}

/**
 * Single-line snippet for the block with this attrs.id, or null when the doc does
 * not parse or the block is missing. Server-side counterpart to the UI walker, so
 * route handlers need not import the client editor module.
 */
export function extractBlockSnippet(
  value: unknown,
  blockId: string,
  maxLength = 120,
): string | null {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return null;

  let found: Record<string, unknown> | null = null;
  const visit = (node: Record<string, unknown>): boolean => {
    const attrs = recordOrEmpty(node.attrs);
    if (attrs.id === blockId) {
      found = node;
      return true;
    }
    const content = Array.isArray(node.content) ? node.content : [];
    return content.some(
      (child) =>
        child !== null && typeof child === 'object' && visit(child as Record<string, unknown>),
    );
  };

  for (const node of parsed.data.content ?? []) {
    if (visit(node)) break;
  }

  if (found === null) return null;
  return textExcerpt(found, maxLength);
}

/**
 * Snippet for a backlink whose source is a crossLinkBlock. The node is an empty
 * atom, so use the enclosing block's text, falling back to the link title.
 */
export function extractCrossLinkSnippet(
  value: unknown,
  fromBlockId: string,
  maxLength = 120,
): string | null {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return null;

  // Track the nearest enclosing block; the link atom itself has no text.
  let result: string | null = null;
  const visit = (node: Record<string, unknown>, enclosing: Record<string, unknown> | null) => {
    if (result !== null) return;
    const attrs = recordOrEmpty(node.attrs);
    if (node.type === 'crossLinkBlock' && attrs.id === fromBlockId) {
      const enclosingText = enclosing ? textExcerpt(enclosing, maxLength) : '';
      if (enclosingText.length > 0) {
        result = enclosingText;
        return;
      }
      if (typeof attrs.title === 'string' && attrs.title.trim().length > 0) {
        const title = attrs.title.trim();
        result =
          title.length > maxLength ? `${title.slice(0, Math.max(0, maxLength - 3))}...` : title;
      }
      return;
    }
    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) {
      if (child !== null && typeof child === 'object') {
        visit(child as Record<string, unknown>, node);
        if (result !== null) return;
      }
    }
  };

  for (const node of parsed.data.content ?? []) {
    visit(node, null);
    if (result !== null) break;
  }
  return result;
}
