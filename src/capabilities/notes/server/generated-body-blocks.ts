import { randomUUID } from 'node:crypto';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { noteBlockSource } from '../shared/note-block-source';

const ANCHORED_TYPES = new Set([
  'semanticBlock',
  'crossLinkBlock',
  'artifactRefBlock',
  'calloutBlock',
]);

/** Initial generation only: content belongs to the model; anchors and trust belong to Notes. */
export function materializeGeneratedBodyBlocks(body: ArtifactBodyBlocksT): ArtifactBodyBlocksT {
  const visit = (node: Record<string, unknown>, topLevel = false): Record<string, unknown> => {
    const attrs = { ...(node.attrs as Record<string, unknown> | undefined) };
    for (const owned of [
      'id',
      'source_markdown',
      'source_tier',
      'user_verified',
      'version',
      'embedded_check',
      'derived_from_block_id',
    ])
      delete attrs[owned];
    const mirror = noteBlockSource(node);
    const anchored = topLevel || ANCHORED_TYPES.has(String(node.type));
    if (anchored) {
      attrs.id = randomUUID();
    }
    if (node.type === 'semanticBlock') {
      Object.assign(attrs, {
        source_tier: 'llm_only',
        user_verified: false,
        version: 1,
        embedded_check: null,
      });
    }
    if (
      anchored &&
      !['crossLinkBlock', 'artifactRefBlock', 'questionRefBlock'].includes(String(node.type))
    ) {
      if (!mirror.trim()) throw new Error('parseNoteGenerateOutput: empty generated content block');
      attrs.source_markdown = mirror;
    }
    return {
      ...node,
      // One live reference consumer: the Notes renderer and backlink index both
      // own crossLinkBlock. Do not persist an unrenderable model alias.
      ...(node.type === 'artifactRefBlock' ? { type: 'crossLinkBlock' } : {}),
      ...(anchored || node.attrs ? { attrs } : {}),
      ...(Array.isArray(node.content)
        ? { content: node.content.map((child) => visit(child)) }
        : {}),
    };
  };
  return { ...body, content: body.content.map((node) => visit(node, true)) };
}
