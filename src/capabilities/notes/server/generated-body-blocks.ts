import { randomUUID } from 'node:crypto';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';

const ANCHORED_TYPES = new Set([
  'semanticBlock',
  'crossLinkBlock',
  'artifactRefBlock',
  'calloutBlock',
]);
const CONTENT_TYPES = new Set([
  'text',
  'paragraph',
  'heading',
  'hardBreak',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'semanticBlock',
  'calloutBlock',
  'crossLinkBlock',
  'artifactRefBlock',
  'questionRefBlock',
  'image',
  'inlineMath',
  'blockMath',
]);

// The current reader/editor uses a source mirror. Derive it from the one model
// body instead of asking the model to author two potentially conflicting copies.
function sourceMirror(node: Record<string, unknown>): string {
  if (!CONTENT_TYPES.has(String(node.type)))
    throw new Error(`parseNoteGenerateOutput: unsupported generated node ${String(node.type)}`);
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const children = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : [];
  if (node.type === 'text') {
    let text = String(node.text ?? '');
    for (const mark of (node.marks ?? []) as Array<{
      type: string;
      attrs?: Record<string, unknown>;
    }>) {
      if (mark.type === 'bold' || mark.type === 'strong') text = `**${text}**`;
      else if (mark.type === 'italic' || mark.type === 'em') text = `_${text}_`;
      else if (mark.type === 'strike') text = `~~${text}~~`;
      else if (mark.type === 'code') text = `\`${text}\``;
      else if (mark.type === 'link') text = `[${text}](${String(mark.attrs?.href ?? '')})`;
      else throw new Error(`parseNoteGenerateOutput: unsupported generated mark ${mark.type}`);
    }
    return text;
  }
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'horizontalRule') return '---';
  if (node.type === 'image') return `![${String(attrs.alt ?? '')}](${String(attrs.src ?? '')})`;
  if (node.type === 'inlineMath' || node.type === 'blockMath')
    return `$${String(attrs.latex ?? '')}$`;
  if (node.type === 'crossLinkBlock' || node.type === 'artifactRefBlock')
    return String(attrs.title ?? attrs.artifact_id ?? '');
  if (node.type === 'questionRefBlock')
    return String(attrs.prompt_preview ?? attrs.question_id ?? '');
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return children
      .map(
        (child, index) =>
          `${node.type === 'bulletList' ? '-' : `${index + Number(attrs.start ?? 1)}.`} ${sourceMirror(child).replaceAll('\n', '\n  ')}`,
      )
      .join('\n');
  }
  const inline = node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock';
  const text = children.map(sourceMirror).join(inline ? '' : '\n\n');
  if (node.type === 'heading')
    return `${'#'.repeat(Math.min(6, Math.max(1, Number(attrs.level ?? 1))))} ${text}`;
  if (node.type === 'blockquote')
    return text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  if (node.type === 'codeBlock') return `\`\`\`${String(attrs.language ?? '')}\n${text}\n\`\`\``;
  if (node.type === 'calloutBlock' && attrs.title) return `${String(attrs.title)}\n\n${text}`;
  return text;
}

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
    const mirror = sourceMirror(node);
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
      ...(anchored || node.attrs ? { attrs } : {}),
      ...(Array.isArray(node.content)
        ? { content: node.content.map((child) => visit(child)) }
        : {}),
    };
  };
  return { ...body, content: body.content.map((node) => visit(node, true)) };
}
