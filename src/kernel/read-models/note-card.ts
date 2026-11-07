// Note card by id: title, body excerpt, updated time. Reads one artifact row; the
// excerpt is derived here from the stored body and is never persisted.
//
// Visibility is the notes owner's read-time rule: existence + not archived + a
// ready note type (pending/failed generation is not content yet) + the artifact
// correction projection (whole retract/supersede hides the card; block retract/
// supersede removes that block from the excerpt). `artifact` has no owner column
// in the single-tenant schema; re-review this read when tenancy lands.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { type ArtifactCorrectionState, getArtifactCorrectionState } from './artifact-corrections';

type DbLike = Db | Tx;

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;
const SUMMARY_MAX = 120;
const SUMMARY_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type NoteEntityCard =
  | {
      entity_kind: 'note';
      entity_id: string;
      state: 'ok';
      title: string;
      summary: string;
      updated_at: string;
    }
  | { entity_kind: 'note'; entity_id: string; state: 'gone' };

// A heading is page furniture, and formulas/code must never survive as half text.
const SKIP_SUBTREES = new Set([
  'heading',
  'codeBlock',
  'blockMath',
  'image',
  'horizontalRule',
  'crossLinkBlock',
  'artifactRefBlock',
  'questionRefBlock',
]);
// Blocks that end a phrase get a separator; inline marks stay glued to their word.
const BLOCK_BOUNDARIES = new Set([
  'doc',
  'paragraph',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'semanticBlock',
  'calloutBlock',
  'hardBreak',
]);

/** Inline Markdown → visible text: no formula source, code ticks, link syntax or marks. */
function normalizeInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g, ' ')
    .replace(/(?<!\\)\$(?!\$)[^$\n]*(?<!\\)\$/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!$>])/g, '$1');
}

const CLOSED_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/m;

/**
 * Markdown source → one plain-text line. `write_note` stores the learner-facing
 * Markdown as a single text node, so node types alone cannot keep headings, code,
 * tables, images or formulas out of the excerpt.
 */
export function markdownToPlainText(markdown: string): string {
  const withoutFences = markdown.replace(CLOSED_FENCE, ' ').replace(OPEN_FENCE, ' ');
  const withoutBlockMath = withoutFences.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  const lines: string[] = [];
  for (const line of withoutBlockMath.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\|.*\|$/.test(trimmed)) continue; // table row
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) continue; // horizontal rule
    if (/^=+\s*$/.test(trimmed)) continue; // setext heading underline
    if (/^#{1,6}\s+/.test(trimmed)) continue; // heading text is page furniture
    const body = normalizeInline(
      trimmed.replace(/^(>\s?)+/, '').replace(/^([-*+]|\d+[.)])\s+/, ''),
    );
    if (body.trim()) lines.push(body.trim());
  }
  return lines.join(' ');
}

function truncateGraphemes(text: string, max: number): string {
  const graphemes: string[] = [];
  for (const segment of SUMMARY_SEGMENTER.segment(text)) graphemes.push(segment.segment);
  if (graphemes.length <= max) return text;
  return `${graphemes.slice(0, max - 1).join('')}…`;
}

function collectSummaryText(
  node: Record<string, unknown>,
  hiddenBlockIds: ReadonlySet<string>,
  out: string[],
): void {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  if (typeof attrs.id === 'string' && hiddenBlockIds.has(attrs.id)) return;

  const type = typeof node.type === 'string' ? node.type : '';
  // The Markdown mirror already carries every child's text; reading it once avoids
  // both duplication and the raw-Markdown paragraph underneath it.
  if (
    type === 'semanticBlock' &&
    typeof attrs.source_markdown === 'string' &&
    attrs.source_markdown.length > 0
  ) {
    out.push(markdownToPlainText(attrs.source_markdown));
    return;
  }
  if (type === 'text') {
    if (typeof node.text === 'string') out.push(normalizeInline(node.text));
    return;
  }
  if (SKIP_SUBTREES.has(type)) return;

  const content = Array.isArray(node.content) ? node.content : [];
  for (const child of content) {
    if (child !== null && typeof child === 'object') {
      collectSummaryText(child as Record<string, unknown>, hiddenBlockIds, out);
    }
  }
  if (BLOCK_BOUNDARIES.has(type)) out.push(' ');
}

/** Plain-text excerpt: no Markdown source, no headings, no formulas, no code. */
export function noteCardSummary(
  body: unknown,
  hiddenBlockIds: ReadonlySet<string> = new Set(),
): string {
  const parsed = ArtifactBodyBlocks.safeParse(body);
  if (!parsed.success) return '';
  const out: string[] = [];
  for (const node of parsed.data.content ?? []) {
    if (node !== null && typeof node === 'object') {
      collectSummaryText(node as Record<string, unknown>, hiddenBlockIds, out);
    }
  }
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  return truncateGraphemes(text, SUMMARY_MAX);
}

function hiddenBlocks(correction: ArtifactCorrectionState): Set<string> {
  const hidden = new Set<string>();
  for (const [blockId, state] of correction.blocks) {
    if (state.state === 'retracted' || state.state === 'superseded') hidden.add(blockId);
  }
  return hidden;
}

async function loadNoteCardRow(db: DbLike, id: string) {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      body_blocks: artifact.body_blocks,
      updated_at: artifact.updated_at,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(
      and(
        eq(artifact.id, id),
        isNull(artifact.archived_at),
        inArray(artifact.type, [...NOTE_TYPES]),
      ),
    )
    .limit(1);
  return rows[0];
}

async function loadVisibleNoteCard(
  db: DbLike,
  id: string,
): Promise<{
  row: NonNullable<Awaited<ReturnType<typeof loadNoteCardRow>>>;
  hidden: Set<string>;
} | null> {
  const row = await loadNoteCardRow(db, id);
  if (!row) return null;
  // Drafts are queued intent, not content; the backlink panel applies the same gate.
  if (row.generation_status !== 'ready') return null;
  const correction = await getArtifactCorrectionState(db, id);
  if (correction.whole.state === 'retracted' || correction.whole.state === 'superseded') {
    return null;
  }
  return { row, hidden: hiddenBlocks(correction) };
}

export async function isNoteCardVisible(db: DbLike, id: string): Promise<boolean> {
  return (await loadVisibleNoteCard(db, id)) !== null;
}

export async function readNoteEntityCard(db: DbLike, id: string): Promise<NoteEntityCard> {
  const visible = await loadVisibleNoteCard(db, id);
  if (!visible) return { entity_kind: 'note', entity_id: id, state: 'gone' };
  return {
    entity_kind: 'note',
    entity_id: id,
    state: 'ok',
    title: visible.row.title,
    summary: noteCardSummary(visible.row.body_blocks, visible.hidden),
    updated_at: visible.row.updated_at.toISOString(),
  };
}
