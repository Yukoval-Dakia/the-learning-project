import type { z } from 'zod';

import { ArtifactBodyBlocks, NoteSection } from '@/core/schema/business';

type NoteSectionT = z.infer<typeof NoteSection>;
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
const SEMANTIC_KINDS = new Set(['definition', 'mechanism', 'example', 'pitfall', 'check']);

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textNode(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

function paragraphNode(text: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    content: text.length > 0 ? [textNode(text)] : [],
  };
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

export function noteSectionsToBodyBlocks(sections: NoteSectionT[]): ArtifactBodyBlocksT {
  return {
    type: 'doc',
    content: sections.map((section) => ({
      type: SEMANTIC_BLOCK_TYPE,
      attrs: {
        id: section.id,
        semantic_kind: section.kind,
        source_tier: section.source_tier,
        user_verified: section.user_verified,
        embedded_check: section.embedded_check ?? null,
        version: section.version,
        source_markdown: section.body_md,
      },
      content: [paragraphNode(section.body_md)],
    })),
  };
}

export function summaryBodyBlocks(blockId: string, summaryMd: string): ArtifactBodyBlocksT {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: blockId },
        content: summaryMd.length > 0 ? [textNode(summaryMd)] : [],
      },
    ],
  };
}

export function artifactRefBlock(
  artifactId: string,
  kind: string,
  opts: { id?: string } = {},
): Record<string, unknown> {
  return {
    type: 'artifactRefBlock',
    attrs: {
      ...(opts.id ? { id: opts.id } : {}),
      artifact_id: artifactId,
      artifact_type: kind,
    },
    content: [],
  };
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

export function bodyBlocksToNoteSections(value: unknown): NoteSectionT[] {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return [];
  const content = parsed.data.content ?? [];
  const out: NoteSectionT[] = [];

  for (const node of content) {
    const attrs = node.attrs;
    if (node.type !== SEMANTIC_BLOCK_TYPE || !attrs || typeof attrs !== 'object') continue;

    const id = (attrs as { id?: unknown }).id;
    const kind = (attrs as { semantic_kind?: unknown }).semantic_kind;
    if (typeof id !== 'string' || typeof kind !== 'string' || !SEMANTIC_KINDS.has(kind)) continue;

    const candidate = {
      id,
      kind,
      body_md:
        typeof (attrs as { source_markdown?: unknown }).source_markdown === 'string'
          ? (attrs as { source_markdown: string }).source_markdown
          : blockText(node),
      source_tier:
        typeof (attrs as { source_tier?: unknown }).source_tier === 'string'
          ? (attrs as { source_tier: string }).source_tier
          : 'llm_only',
      user_verified:
        typeof (attrs as { user_verified?: unknown }).user_verified === 'boolean'
          ? (attrs as { user_verified: boolean }).user_verified
          : false,
      embedded_check:
        (attrs as { embedded_check?: unknown }).embedded_check === undefined
          ? null
          : (attrs as { embedded_check?: unknown }).embedded_check,
      version:
        typeof (attrs as { version?: unknown }).version === 'number'
          ? (attrs as { version: number }).version
          : 0,
    };
    const section = NoteSection.safeParse(candidate);
    if (section.success) out.push(section.data);
  }

  return out;
}

export function bodyBlocksContainId(value: unknown, blockId: string): boolean {
  const parsed = ArtifactBodyBlocks.safeParse(value);
  if (!parsed.success) return false;

  const visit = (node: Record<string, unknown>): boolean => {
    const attrs = recordOrEmpty(node.attrs);
    if (attrs.id === blockId) return true;
    const content = Array.isArray(node.content) ? node.content : [];
    return content.some(
      (child) =>
        child !== null && typeof child === 'object' && visit(child as Record<string, unknown>),
    );
  };

  return (parsed.data.content ?? []).some((node) => visit(node));
}

export function replaceNoteSectionBody(
  value: unknown,
  sectionId: string,
  nextBodyMd: string,
): ArtifactBodyBlocksT {
  const parsed = ArtifactBodyBlocks.parse(value);
  return {
    ...parsed,
    content: parsed.content.map((node) => {
      const attrs = node.attrs as { id?: unknown; version?: unknown } | undefined;
      if (node.type !== SEMANTIC_BLOCK_TYPE || attrs?.id !== sectionId) return node;
      const version = typeof attrs.version === 'number' ? attrs.version + 1 : 1;
      const preservedRefs = Array.isArray(node.content)
        ? node.content.filter(
            (child) =>
              child !== null &&
              typeof child === 'object' &&
              (child as Record<string, unknown>).type === 'artifactRefBlock',
          )
        : [];
      return {
        ...node,
        attrs: { ...recordOrEmpty(node.attrs), version, source_markdown: nextBodyMd },
        content: [paragraphNode(nextBodyMd), ...preservedRefs],
      };
    }),
  };
}

export function setNoteSectionEmbeddedCheck(
  value: unknown,
  sectionId: string,
  questionIds: string[],
): ArtifactBodyBlocksT {
  const parsed = ArtifactBodyBlocks.parse(value);
  return {
    ...parsed,
    content: parsed.content.map((node) => {
      const attrs = node.attrs as { id?: unknown } | undefined;
      if (node.type !== SEMANTIC_BLOCK_TYPE || attrs?.id !== sectionId) return node;
      return {
        ...node,
        attrs: {
          ...recordOrEmpty(node.attrs),
          embedded_check: { question_ids: questionIds },
        },
      };
    }),
  };
}

export function setNoteSectionEmbeddedCheckArtifactRef(
  value: unknown,
  sectionId: string,
  artifactId: string,
  questionIds: string[],
): ArtifactBodyBlocksT {
  const parsed = ArtifactBodyBlocks.parse(value);
  const refId = `${sectionId}_quiz_ref`;
  return {
    ...parsed,
    content: parsed.content.map((node) => {
      const attrs = node.attrs as { id?: unknown } | undefined;
      if (node.type !== SEMANTIC_BLOCK_TYPE || attrs?.id !== sectionId) return node;
      const content = Array.isArray(node.content)
        ? node.content.filter((child) => {
            if (child === null || typeof child !== 'object') return true;
            const childAttrs = recordOrEmpty((child as Record<string, unknown>).attrs);
            return childAttrs.id !== refId;
          })
        : [];
      return {
        ...node,
        attrs: {
          ...recordOrEmpty(node.attrs),
          embedded_check: { question_ids: questionIds },
        },
        content: [...content, artifactRefBlock(artifactId, 'tool_quiz', { id: refId })],
      };
    }),
  };
}
