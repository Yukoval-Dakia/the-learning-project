// Shared admission source binding: the publication event, or — for questions edited
// after publication — the original `question_draft_submit` receipt that enqueue and the
// admission handler already accept. One SQL definition serves the owner (enqueue) and
// the serving read model, so "has a source" cannot drift between them.

import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

/** Question sources that come from a photographed or uploaded page. */
export const INGESTION_QUESTION_SOURCES = [
  'ingestion',
  'vision_paper',
  'vision_single',
  'camera',
  'import',
  'pdf',
  'docx',
  'photo',
  'reverse_mark',
] as const;

export type IngestionQuestionSource = (typeof INGESTION_QUESTION_SOURCES)[number];

export function isIngestionQuestionSource(source: string | null | undefined): boolean {
  return source != null && (INGESTION_QUESTION_SOURCES as readonly string[]).includes(source);
}

/** `in (…)` operand; callers wrap with their own column. */
export function ingestionQuestionSourceListSql(): SQL {
  return sql`(${sql.join(
    INGESTION_QUESTION_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )})`;
}

export interface AdmissionSourceBindingColumns {
  publicationEventId: SQLWrapper;
  publicationSessionId: SQLWrapper;
  publicationCausedByEventId: SQLWrapper;
  publicationActorRef: SQLWrapper;
  groupId: SQLWrapper;
  revisionId: SQLWrapper;
}

/**
 * The event that authorises paid admission for a publication: the publication itself
 * when it carries a session or a cause; otherwise the single immutable first-publication
 * receipt bound to the same revision/group/actor. Null = unbound (must not spend).
 */
export function admissionSourceEventIdSql(
  columns: AdmissionSourceBindingColumns,
): SQL<string | null> {
  return sql<string | null>`case
    when ${columns.publicationSessionId} is not null
      or ${columns.publicationCausedByEventId} is not null
      then ${columns.publicationEventId}
    else (
      select case when count(*) = 1 then min(receipt.id) end
      from event receipt
      where receipt.action = 'experimental:question_draft_submit'
        and receipt.outcome = 'success'
        and receipt.payload->'receipt'->>'revision_id' = ${columns.revisionId}
        and coalesce(receipt.payload->'receipt'->>'group_id', receipt.payload->'receipt'->>'question_id') = ${columns.groupId}
        and receipt.payload->'receipt'->>'publish_status' = 'published'
        and receipt.payload->'receipt'->>'status' in ('admitted', 'withheld', 'pending')
        and 'submit_question:' || receipt.actor_ref = ${columns.publicationActorRef}
    )
  end`;
}
