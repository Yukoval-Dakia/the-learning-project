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

import { and, desc, inArray, isNull, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';

type DbLike = Db | Tx;

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;

export interface NoteSummary {
  id: string;
  // note_atomic | note_hub | note_long
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
