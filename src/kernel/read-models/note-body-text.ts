// Full-text read projection of a note body for model-facing consumers:
// formulas, headings, lists and code kept (unlike the card summary, which is a
// plain-text excerpt for lists). Unknown block shapes degrade to their text.

import { ArtifactBodyBlocks } from '@/core/schema/business';
import { noteBlockSource } from '@/kernel/read-models/note-block-source';

// Teaching-style consumers get a bounded body: long notes keep their leading
// structure and the tail is marked instead of silently dropped.
export const NOTE_BODY_TEXT_MAX = 4000;

function plainTextFallback(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text;
  const content = Array.isArray(node.content) ? node.content : [];
  return content
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map(plainTextFallback)
    .join('');
}

function blockSource(node: Record<string, unknown>): string {
  try {
    return noteBlockSource(node);
  } catch {
    return plainTextFallback(node);
  }
}

/**
 * Note body as text with structure and formulas preserved; null when the body
 * does not parse or carries no content. Over `maxChars` the tail is cut and a
 * truncation marker appended.
 */
export function noteBodyText(body: unknown, maxChars = NOTE_BODY_TEXT_MAX): string | null {
  const parsed = ArtifactBodyBlocks.safeParse(body);
  if (!parsed.success) return null;
  const parts = (parsed.data.content ?? [])
    .filter((n): n is Record<string, unknown> => n !== null && typeof n === 'object')
    .map((node) => blockSource(node).trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const joined = parts.join('\n\n');
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars).trimEnd()}\n\n…（正文过长，已截断）`;
}
