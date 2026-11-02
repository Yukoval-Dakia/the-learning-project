// Top-level semantic blocks projected as note sections. Notes keeps block-tree
// edits; Copilot teaching and note reads share this projection.
import type { z } from 'zod';
import { ArtifactBodyBlocks, NoteSection } from '@/core/schema/business';

type NoteSectionT = z.infer<typeof NoteSection>;

const SEMANTIC_BLOCK_TYPE = 'semanticBlock';
const SEMANTIC_KINDS = new Set(['definition', 'mechanism', 'example', 'pitfall', 'check']);

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
