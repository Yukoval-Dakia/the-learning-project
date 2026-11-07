// The reader renders a note block's source_markdown, but the editor rebuilds
// that mirror from the block content. A model write must therefore downgrade
// both copies from the same result, or an edit republishes the fake source.

import { downgradeUnboundChartFences } from '@/kernel/blocks/markdown-chart-fence';
import { noteBlockSource } from './note-block-source';

function collectText(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (record.type === 'text') return typeof record.text === 'string' ? record.text : '';
  if (!Array.isArray(record.content)) return '';
  return record.content.map((child) => collectText(child)).join('');
}

/**
 * Sanitize a codeBlock through a real fence so escaped/entity/attribute info
 * strings are decoded exactly as the reader decodes them. Returns the rewritten
 * body, or null when this is not an unbound recorded-data chart.
 */
function downgradeCodeBlock(record: Record<string, unknown>): string | null {
  const attrs = record.attrs;
  const language =
    attrs !== null && typeof attrs === 'object'
      ? (attrs as Record<string, unknown>).language
      : undefined;
  const info = typeof language === 'string' ? language : '';
  const text = collectText(record);
  const fence = `\`\`\`${info}\n${text}\n\`\`\``;
  const sanitized = downgradeUnboundChartFences(fence);
  if (sanitized === fence) return null;
  const first = sanitized.indexOf('\n');
  const last = sanitized.lastIndexOf('\n');
  if (first < 0 || last <= first) throw new Error('chart fence rewrite lost its fence delimiters');
  return sanitized.slice(first + 1, last);
}

/** Downgrade chart fences in a note body/patch, keeping content and mirror equal. */
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
      // Code block text can arrive split across several text nodes; the fence
      // wrapper sees the complete value before deciding.
      const downgraded = downgradeCodeBlock(record);
      if (downgraded !== null) record.content = [{ type: 'text', text: downgraded }];
      return;
    }
    if (record.type === 'paragraph' || record.type === 'heading') {
      const source = noteBlockSource(record);
      const downgraded = downgradeUnboundChartFences(source);
      if (downgraded !== source) {
        record.content = [{ type: 'text', text: downgraded }];
        return;
      }
    }
    if (Array.isArray(record.content)) visit(record.content);
  };
  visit(clone);
  return clone;
}
