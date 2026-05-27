import type { z } from 'zod';

import { ArtifactBodyBlocks, NoteSection } from '@/core/schema/business';

type NoteSectionT = z.infer<typeof NoteSection>;
type ArtifactBodyBlocksT = z.infer<typeof ArtifactBodyBlocks>;

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
      return {
        ...node,
        attrs: { ...recordOrEmpty(node.attrs), version, source_markdown: nextBodyMd },
        content: [paragraphNode(nextBodyMd)],
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
