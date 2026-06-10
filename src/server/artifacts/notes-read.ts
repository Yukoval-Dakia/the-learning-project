// YUK-203 P1 (ADR-0027) — note(artifact) reads by knowledge label.
//
// ADR-0027 makes a note(artifact) a first-class knowledge-labeled entity: a
// knowledge node may carry 0..N labeled notes (atomic 节点简介 + hub 主题入口 +
// long 跨主题综合), not a single learning_item-owned primary. This reader returns
// the notes labeled with a given knowledge id so the /knowledge/[id] page can list
// ALL labeled notes (2b brief: "带当前 knowledge_id 标签的笔记列表 0/1/many"),
// superseding the node page's single-primary-atomic read.
//
// Label model only (ADR-0020 §3): membership is `artifact.knowledge_ids` containing
// the node id — NOT learning_item ownership. tool_quiz is excluded (it is a quiz
// artifact, not a note).

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';

type DbLike = Db | Tx;

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;

export interface NoteSummary {
  id: string;
  // note_atomic | note_hub | note_long — or 'interactive' when produced by
  // interactiveForKnowledge (ADR-0033 D5; same summary shape, distinct read path).
  type: string;
  title: string;
  // all knowledge labels on this note (the caller highlights the focal one).
  knowledge_ids: string[];
  generation_status: string;
  verification_status: string;
  version: number;
  updated_at: string;
}

const NOTE_TYPE_ORDER = sql`CASE ${artifact.type} WHEN 'note_atomic' THEN 0 WHEN 'note_hub' THEN 1 WHEN 'note_long' THEN 2 ELSE 3 END`;

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
 * All non-archived notes (atomic/hub/long) labeled with `knowledgeId` via
 * `artifact.knowledge_ids @> [knowledgeId]`. Ordered atomic → hub → long (节点简介
 * first, then topic-entry, then long synthesis), newest within each type.
 * Returns [] when the node has no labeled notes (the page renders an empty state).
 */
export async function notesForKnowledge(db: DbLike, knowledgeId: string): Promise<NoteSummary[]> {
  const rows = await db
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
  return rows.map(toNoteSummary);
}

/**
 * ADR-0033 D5 — non-archived interactive artifacts labeled with `knowledgeId`
 * (newest first), powering the /knowledge/[id] "互动内容" listing. Deliberately a
 * PARALLEL query to notesForKnowledge rather than a widened NOTE_TYPES:
 * NOTE_TYPES also gates the note-only read paths (notesForItem's primary
 * resolution + label-material overlap) and must NOT admit 'interactive' —
 * interactive artifacts are opaque to all note machinery (body_blocks null,
 * no verification / embedded-check / cross-link).
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
  // 'primary' = the item's primary_artifact_id points here; 'label' = shares ≥1
  // knowledge label with the item (study material). primary wins on dedupe.
  relation: 'primary' | 'label';
}

// The learning_item fields notesForItem reads — pass the row (or a projection).
export interface LearningItemNoteRefs {
  primary_artifact_id: string | null;
  knowledge_ids: string[];
}

/**
 * Notes a learning_item *references* (ADR-0027 — it no longer owns them): its
 * `primary_artifact_id` note (when that resolves to a non-archived note) plus
 * notes sharing ≥1 of the item's knowledge labels (study material). Deduped with
 * primary winning; primary first, then atomic→hub→long newest-within-type.
 * Powers the /learning-items/[id] "关联笔记" surface (wired in P5).
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

  // label: notes sharing ≥1 of the item's knowledge labels. OR of `@>` per label
  // reuses the established containment pattern (no `?|` operator).
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
