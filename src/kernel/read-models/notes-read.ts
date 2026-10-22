// Note (artifact) reads by knowledge label. A note may carry 0..N labels rather
// than one primary owner; tool_quiz is excluded because it is a quiz, not a note.

import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';

type DbLike = Db | Tx;

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;

export interface NoteSummary {
  id: string;
  // note_atomic | note_hub | note_long, or 'interactive' from
  // interactiveForKnowledge (same summary shape, distinct read path).
  type: string;
  title: string;
  // All labels; the caller highlights the focal one.
  knowledge_ids: string[];
  generation_status: string;
  verification_status: string;
  version: number;
  updated_at: string;
}

const NOTE_TYPE_ORDER = sql`CASE ${artifact.type} WHEN 'note_atomic' THEN 0 WHEN 'note_hub' THEN 1 WHEN 'note_long' THEN 2 ELSE 3 END`;

// Escape ILIKE wildcards so user input matches literally.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toNoteSummary(row: {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  generation_status: string;
  verification_status: string;
  version: number;
  updated_at: Date;
}): NoteSummary {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    knowledge_ids: row.knowledge_ids ?? [],
    generation_status: row.generation_status,
    verification_status: row.verification_status,
    version: row.version,
    updated_at: row.updated_at.toISOString(),
  };
}

const NOTE_SUMMARY_COLUMNS = {
  id: artifact.id,
  type: artifact.type,
  title: artifact.title,
  knowledge_ids: artifact.knowledge_ids,
  generation_status: artifact.generation_status,
  verification_status: artifact.verification_status,
  version: artifact.version,
  updated_at: artifact.updated_at,
} as const;

/**
 * Non-archived notes labeled with the node, atomic -> hub -> long, newest first.
 * Returns [] when the node has no labeled notes.
 */
export async function notesForKnowledge(
  db: DbLike,
  knowledgeId: string,
  options: { limit?: number } = {},
): Promise<NoteSummary[]> {
  const query = db
    .select(NOTE_SUMMARY_COLUMNS)
    .from(artifact)
    .where(
      and(
        inArray(artifact.type, [...NOTE_TYPES]),
        isNull(artifact.archived_at),
        sql`${artifact.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
      ),
    )
    .orderBy(NOTE_TYPE_ORDER, desc(artifact.created_at));
  const rows = options.limit === undefined ? await query : await query.limit(options.limit);
  return rows.map(toNoteSummary);
}

export async function listNotes(
  db: DbLike,
  subjectKnowledgeIds?: string[],
  textQuery?: string,
): Promise<NoteSummary[]> {
  if (subjectKnowledgeIds?.length === 0) return [];
  const conditions = [inArray(artifact.type, [...NOTE_TYPES]), isNull(artifact.archived_at)];
  if (subjectKnowledgeIds) {
    const subjectFilter = or(
      ...subjectKnowledgeIds.map(
        (id) => sql`${artifact.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
      ),
    );
    if (subjectFilter) conditions.push(subjectFilter);
  }
  if (textQuery) {
    // Match title or serialized body_blocks; a NULL body falls back to title only.
    // Combined with the subject filter via AND.
    const pattern = `%${escapeLike(textQuery)}%`;
    const textFilter = or(
      ilike(artifact.title, pattern),
      sql`${artifact.body_blocks}::text ilike ${pattern}`,
    );
    if (textFilter) conditions.push(textFilter);
  }
  const rows = await db
    .select(NOTE_SUMMARY_COLUMNS)
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.updated_at));
  return rows.map(toNoteSummary);
}

/**
 * Non-archived interactive artifacts for the node, newest first. Kept parallel to
 * notesForKnowledge so NOTE_TYPES never admits 'interactive' into note machinery.
 */
export async function interactiveForKnowledge(
  db: DbLike,
  knowledgeId: string,
): Promise<NoteSummary[]> {
  const rows = await db
    .select(NOTE_SUMMARY_COLUMNS)
    .from(artifact)
    .where(
      and(
        eq(artifact.type, 'interactive'),
        isNull(artifact.archived_at),
        sql`${artifact.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
      ),
    )
    .orderBy(desc(artifact.created_at));
  return rows.map(toNoteSummary);
}

export interface ItemNote extends NoteSummary {
  // primary = primary_artifact_id; label = shares a knowledge label. primary wins
  // on dedupe.
  relation: 'primary' | 'label';
}

// The learning_item fields notesForItem reads — pass the row (or a projection).
export interface LearningItemNoteRefs {
  primary_artifact_id: string | null;
  knowledge_ids: string[];
}

/**
 * Notes the item references: its primary note plus notes sharing a label, deduped
 * with primary first, then atomic -> hub -> long.
 */
export async function notesForItem(db: DbLike, item: LearningItemNoteRefs): Promise<ItemNote[]> {
  const out: ItemNote[] = [];
  const seen = new Set<string>();

  // primary: the item's primary_artifact_id, if it resolves to a non-archived note.
  if (item.primary_artifact_id) {
    const primaryRows = await db
      .select(NOTE_SUMMARY_COLUMNS)
      .from(artifact)
      .where(
        and(
          eq(artifact.id, item.primary_artifact_id),
          inArray(artifact.type, [...NOTE_TYPES]),
          isNull(artifact.archived_at),
        ),
      )
      .limit(1);
    const primary = primaryRows[0];
    if (primary) {
      seen.add(primary.id);
      out.push({ ...toNoteSummary(primary), relation: 'primary' });
    }
  }

  // OR of containment checks per label.
  const labels = item.knowledge_ids ?? [];
  if (labels.length > 0) {
    const overlap = labels.map(
      (kid) => sql`${artifact.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
    );
    const labelRows = await db
      .select(NOTE_SUMMARY_COLUMNS)
      .from(artifact)
      .where(
        and(inArray(artifact.type, [...NOTE_TYPES]), isNull(artifact.archived_at), or(...overlap)),
      )
      .orderBy(NOTE_TYPE_ORDER, desc(artifact.created_at));
    for (const row of labelRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ ...toNoteSummary(row), relation: 'label' });
    }
  }
  return out;
}
