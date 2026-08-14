import { learning_record } from '@/db/schema';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { excerpt, recordKnowledgeContainsAny } from './record-tool-support';
import type { DomainTool, ToolContext } from './types';

const QueryRecordsInputSchema = z.object({
  kind: z.array(z.string()).optional(),
  knowledgeIds: z.array(z.string()).optional(),
  subjectId: z.string().optional(),
  questionId: z.string().optional(),
  activityKind: z.array(z.string()).optional(),
  originEventId: z.string().optional(),
  attemptEventId: z.string().optional(),
  learningItemId: z.string().optional(),
  processingStatus: z.array(z.string()).optional(),
  query: z.string().optional(),
  sinceDays: z.number().int().positive().max(365).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const RecordListRowSchema = z.object({
  record_id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  excerpt: z.string(),
  source: z.string(),
  capture_mode: z.string(),
  activity_kind: z.string(),
  origin_event_id: z.string().nullable(),
  processing_status: z.string(),
  knowledge_ids: z.array(z.string()),
  links: z.object({
    question_id: z.string().nullable(),
    attempt_event_id: z.string().nullable(),
    artifact_id: z.string().nullable(),
    learning_item_id: z.string().nullable(),
    source_document_id: z.string().nullable(),
  }),
  created_at: z.string(),
});

const QueryRecordsOutputSchema = z.object({
  rows: z.array(RecordListRowSchema),
  claim_boundaries: z.object({
    zero_rows_scope: z.literal('matching_learning_record_rows_only'),
    supports_entity_inventory_claim: z.literal(false),
    supports_lifecycle_status_count_claim: z.literal(false),
  }),
});

type QueryRecordsInput = z.infer<typeof QueryRecordsInputSchema>;
type QueryRecordsOutput = z.infer<typeof QueryRecordsOutputSchema>;

async function executeQueryRecords(
  ctx: ToolContext,
  raw: QueryRecordsInput,
): Promise<QueryRecordsOutput> {
  const input = QueryRecordsInputSchema.parse(raw);
  const conditions = [isNull(learning_record.archived_at)];
  if (input.kind?.length) conditions.push(inArray(learning_record.kind, input.kind));
  if (input.subjectId) conditions.push(eq(learning_record.subject_id, input.subjectId));
  if (input.questionId) conditions.push(eq(learning_record.question_id, input.questionId));
  if (input.activityKind?.length) {
    conditions.push(inArray(learning_record.activity_kind, input.activityKind));
  }
  if (input.originEventId)
    conditions.push(eq(learning_record.origin_event_id, input.originEventId));
  if (input.attemptEventId) {
    conditions.push(eq(learning_record.attempt_event_id, input.attemptEventId));
  }
  if (input.learningItemId) {
    conditions.push(eq(learning_record.learning_item_id, input.learningItemId));
  }
  if (input.processingStatus?.length) {
    conditions.push(inArray(learning_record.processing_status, input.processingStatus));
  }
  if (input.knowledgeIds?.length) {
    conditions.push(recordKnowledgeContainsAny(input.knowledgeIds));
  }
  if (input.sinceDays) {
    conditions.push(
      gte(learning_record.created_at, new Date(Date.now() - input.sinceDays * 86_400_000)),
    );
  }
  if (input.query) {
    const pattern = `%${input.query}%`;
    const textCondition = or(
      sql`${learning_record.title} ILIKE ${pattern}`,
      sql`${learning_record.content_md} ILIKE ${pattern}`,
    );
    if (textCondition) conditions.push(textCondition);
  }
  const rows = await ctx.db
    .select()
    .from(learning_record)
    .where(and(...conditions))
    .orderBy(desc(learning_record.created_at), desc(learning_record.id))
    .limit(input.limit ?? 20);

  return QueryRecordsOutputSchema.parse({
    rows: rows.map((row) => ({
      record_id: row.id,
      kind: row.kind,
      title: row.title ?? null,
      excerpt: excerpt(row.content_md),
      source: row.source,
      capture_mode: row.capture_mode,
      activity_kind: row.activity_kind,
      origin_event_id: row.origin_event_id ?? null,
      processing_status: row.processing_status,
      knowledge_ids: row.knowledge_ids ?? [],
      links: {
        question_id: row.question_id ?? null,
        attempt_event_id: row.attempt_event_id ?? null,
        artifact_id: row.artifact_id ?? null,
        learning_item_id: row.learning_item_id ?? null,
        source_document_id: row.source_document_id ?? null,
      },
      created_at: row.created_at.toISOString(),
    })),
    claim_boundaries: {
      zero_rows_scope: 'matching_learning_record_rows_only',
      supports_entity_inventory_claim: false,
      supports_lifecycle_status_count_claim: false,
    },
  });
}

export const queryRecordsTool: DomainTool<QueryRecordsInput, QueryRecordsOutput> = {
  name: 'query_records',
  description:
    'Read bounded activity-grounded LearningRecord rows with filters for kind, knowledge, question, attempt, item, and text. processing_status is a LearningRecord ingestion/linking state, not a LearningItem or intervention lifecycle status. rows=[] only means zero matching returned LearningRecord rows and cannot prove those entities are absent. claim_boundaries forbids entity inventory and lifecycle-status claims, and this tool must not override get_review_due.queue_assertion nulls or entity_status_coverage=not_observed.',
  effect: 'read',
  inputSchema: QueryRecordsInputSchema,
  outputSchema: QueryRecordsOutputSchema,
  costClass: 'local',
  execute: executeQueryRecords,
  summarize(input, output) {
    const kind = input.kind?.join(',') ?? 'all';
    return `records · ${kind} · ${output.rows.length} rows`;
  },
  mirrorEvent: 'when_user_visible',
};
