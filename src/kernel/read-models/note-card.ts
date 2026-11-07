// Note card by id: title, body excerpt, updated time. Reads one artifact row; the
// excerpt is derived here from the stored body and is never persisted.
//
// Visibility is existence + not archived + a note type. `artifact` has no owner
// column in the single-tenant schema; re-review this read when tenancy lands.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';

type DbLike = Db | Tx;

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;
const SUMMARY_MAX = 120;

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

function collectText(node: Record<string, unknown>, out: string[]): void {
  const type = typeof node.type === 'string' ? node.type : '';
  if (type === 'text') {
    if (typeof node.text === 'string') out.push(node.text);
    return;
  }
  if (type === 'inlineMath') {
    // Drop the formula whole; surrounding whitespace already separates words.
    return;
  }
  if (SKIP_SUBTREES.has(type)) {
    out.push(' ');
    return;
  }
  const content = Array.isArray(node.content) ? node.content : [];
  for (const child of content) {
    if (child !== null && typeof child === 'object') {
      collectText(child as Record<string, unknown>, out);
    }
  }
  if (BLOCK_BOUNDARIES.has(type)) out.push(' ');
}

/** Plain-text excerpt: no Markdown source, no headings, no formulas, no code. */
export function noteCardSummary(body: unknown): string {
  const doc = body as { type?: unknown; content?: unknown } | null | undefined;
  if (doc?.type !== 'doc' || !Array.isArray(doc.content)) return '';
  const out: string[] = [];
  for (const node of doc.content) {
    if (node !== null && typeof node === 'object') {
      collectText(node as Record<string, unknown>, out);
    }
  }
  const text = out.join('').replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX) return text;
  return `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

async function loadNoteCardRow(db: DbLike, id: string) {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      body_blocks: artifact.body_blocks,
      updated_at: artifact.updated_at,
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

export async function isNoteCardVisible(db: DbLike, id: string): Promise<boolean> {
  return (await loadNoteCardRow(db, id)) !== undefined;
}

export async function readNoteEntityCard(db: DbLike, id: string): Promise<NoteEntityCard> {
  const note = await loadNoteCardRow(db, id);
  if (!note) return { entity_kind: 'note', entity_id: id, state: 'gone' };
  return {
    entity_kind: 'note',
    entity_id: id,
    state: 'ok',
    title: note.title,
    summary: noteCardSummary(note.body_blocks),
    updated_at: note.updated_at.toISOString(),
  };
}
