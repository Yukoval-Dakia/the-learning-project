// YUK-102 / Foundation D M2
//
// Composite read tools for records, questions, due review cards, learning
// items, and Dreaming-maintained memory briefs.

import type { Db } from '@/db/client';
import {
  artifact,
  completion_evidence,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  material_fsrs_state,
  memory_brief_note,
  mistake_variant,
  question,
} from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import {
  getFailureAttemptById,
  getFailureAttempts,
  getQuestionTimeline,
  getRecentReviewEvents,
} from '@/server/events/queries';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const EXCERPT_MAX = 220;

function excerpt(value: string | null | undefined, max = EXCERPT_MAX): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

type KnowledgeRow = {
  id: string;
  name: string;
  parent_id: string | null;
};

async function loadKnowledgeRows(db: Db, ids: string[]): Promise<Map<string, KnowledgeRow>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const idOrParent = or(inArray(knowledge.id, unique), inArray(knowledge.parent_id, unique));
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, parent_id: knowledge.parent_id })
    .from(knowledge)
    .where(idOrParent ?? inArray(knowledge.id, unique));

  // Pull ancestors lazily until no new parent is discovered. Graphs are tiny in
  // the current single-user runtime, so this bounded loop is clearer than a
  // recursive SQL CTE inside every tool.
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (;;) {
    const missingParents = [...byId.values()]
      .map((row) => row.parent_id)
      .filter((id): id is string => !!id && !byId.has(id));
    if (missingParents.length === 0) break;
    const parents = await db
      .select({ id: knowledge.id, name: knowledge.name, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(inArray(knowledge.id, [...new Set(missingParents)]));
    if (parents.length === 0) break;
    for (const parent of parents) byId.set(parent.id, parent);
  }
  return byId;
}

function pathFor(id: string, byId: Map<string, KnowledgeRow>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return out;
}

async function knowledgeContext(
  db: Db,
  ids: string[],
): Promise<Array<{ knowledge_id: string; path: string[]; mastery: number | null }>> {
  const byId = await loadKnowledgeRows(db, ids);
  return [...new Set(ids)].map((id) => ({
    knowledge_id: id,
    path: pathFor(id, byId),
    mastery: null,
  }));
}

function knowledgeEdgeTouches(ids: string[]) {
  return (
    or(
      inArray(knowledge_edge.from_knowledge_id, ids),
      inArray(knowledge_edge.to_knowledge_id, ids),
    ) ?? inArray(knowledge_edge.from_knowledge_id, ids)
  );
}

function recordKnowledgeContainsAny(ids: string[]) {
  const conditions = ids.map(
    (id) => sql`${learning_record.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return or(...conditions) ?? sql`FALSE`;
}

function questionKnowledgeContainsAny(ids: string[]) {
  const conditions = ids.map(
    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return or(...conditions) ?? sql`FALSE`;
}

function bodyBlockSummaries(bodyBlocks: unknown): string[] {
  if (!bodyBlocks || typeof bodyBlocks !== 'object') return [];
  const content = (bodyBlocks as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.slice(0, 6).map((block) => {
    if (!block || typeof block !== 'object') return 'block';
    const typed = block as {
      type?: string;
      attrs?: { semantic_kind?: string; title?: string };
      content?: unknown[];
    };
    const text = JSON.stringify(typed.content ?? [])
      .replace(/[{}\[\]",:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const label = typed.attrs?.semantic_kind ?? typed.type ?? 'block';
    return `${label}: ${excerpt(typed.attrs?.title ?? text, 120)}`;
  });
}

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

const QueryRecordsOutputSchema = z.object({ rows: z.array(RecordListRowSchema) });

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
  if (input.attemptEventId)
    conditions.push(eq(learning_record.attempt_event_id, input.attemptEventId));
  if (input.learningItemId)
    conditions.push(eq(learning_record.learning_item_id, input.learningItemId));
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
  });
}

const GetRecordContextInputSchema = z.object({
  recordId: z.string().min(1),
  include: z
    .array(
      z.enum([
        'question',
        'attempt',
        'attribution',
        'review_history',
        'artifact',
        'learning_item',
        'knowledge_context',
        'event_chain',
      ]),
    )
    .optional(),
});

const GetRecordContextOutputSchema = z.object({
  record: z
    .object({
      id: z.string(),
      kind: z.string(),
      title: z.string().nullable(),
      content_md: z.string(),
      source: z.string(),
      capture_mode: z.string(),
      activity_kind: z.string(),
      origin_event_id: z.string().nullable(),
      processing_status: z.string(),
      knowledge_ids: z.array(z.string()),
      created_at: z.string(),
    })
    .nullable(),
  question: z
    .object({
      id: z.string(),
      prompt_md: z.string(),
      reference_md: z.string().nullable(),
      knowledge_ids: z.array(z.string()),
    })
    .optional(),
  attempt: z
    .object({
      attempt_event_id: z.string(),
      answer_md: z.string().nullable(),
      answer_image_refs: z.array(z.string()),
      outcome: z.string().nullable(),
    })
    .optional(),
  attribution: z
    .object({
      user_cause: z.unknown().optional(),
      judge: z.unknown().optional(),
      chosen_source: z.enum(['user', 'judge', 'none']),
    })
    .optional(),
  artifact: z.object({ id: z.string(), type: z.string(), summary: z.string() }).optional(),
  learning_item: z.object({ id: z.string(), title: z.string(), status: z.string() }).optional(),
  knowledge_context: z
    .object({
      paths: z.array(z.array(z.string())),
      related_edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          relation_type: z.string(),
          reason: z.string(),
        }),
      ),
    })
    .optional(),
  event_chain: z
    .object({
      parent: z.string().nullable(),
      children: z.array(z.object({ id: z.string(), action: z.string() })),
    })
    .optional(),
});

type GetRecordContextInput = z.infer<typeof GetRecordContextInputSchema>;
type GetRecordContextOutput = z.infer<typeof GetRecordContextOutputSchema>;

async function executeGetRecordContext(
  ctx: ToolContext,
  raw: GetRecordContextInput,
): Promise<GetRecordContextOutput> {
  const input = GetRecordContextInputSchema.parse(raw);
  const include = new Set(
    input.include ?? ['question', 'attempt', 'attribution', 'knowledge_context'],
  );
  const rows = await ctx.db
    .select()
    .from(learning_record)
    .where(eq(learning_record.id, input.recordId))
    .limit(1);
  const record = rows[0] ?? null;
  if (!record) return GetRecordContextOutputSchema.parse({ record: null });

  const output: GetRecordContextOutput = {
    record: {
      id: record.id,
      kind: record.kind,
      title: record.title ?? null,
      content_md: record.content_md,
      source: record.source,
      capture_mode: record.capture_mode,
      activity_kind: record.activity_kind,
      origin_event_id: record.origin_event_id ?? null,
      processing_status: record.processing_status,
      knowledge_ids: record.knowledge_ids ?? [],
      created_at: record.created_at.toISOString(),
    },
  };

  if (include.has('question') && record.question_id) {
    const [q] = await ctx.db
      .select()
      .from(question)
      .where(eq(question.id, record.question_id))
      .limit(1);
    if (q) {
      output.question = {
        id: q.id,
        prompt_md: q.prompt_md,
        reference_md: q.reference_md ?? null,
        knowledge_ids: q.knowledge_ids ?? [],
      };
    }
  }

  const failure = record.attempt_event_id
    ? await getFailureAttemptById(ctx.db, record.attempt_event_id)
    : null;
  if (include.has('attempt') && failure) {
    output.attempt = {
      attempt_event_id: failure.attempt_event_id,
      answer_md: failure.answer_md,
      answer_image_refs: failure.answer_image_refs,
      outcome: 'failure',
    };
  }
  if (include.has('attribution') && failure) {
    const cause = effectiveCauseForFailureAttempt(failure);
    output.attribution = {
      user_cause: failure.user_cause ?? undefined,
      judge: failure.judge ?? undefined,
      chosen_source:
        cause?.source === 'user' ? 'user' : cause?.source === 'agent' ? 'judge' : 'none',
    };
  }
  if (include.has('artifact') && record.artifact_id) {
    const [a] = await ctx.db
      .select()
      .from(artifact)
      .where(eq(artifact.id, record.artifact_id))
      .limit(1);
    if (a) {
      output.artifact = {
        id: a.id,
        type: a.type,
        summary: bodyBlockSummaries(a.body_blocks).join(' | ') || a.title,
      };
    }
  }
  if (include.has('learning_item') && record.learning_item_id) {
    const [li] = await ctx.db
      .select()
      .from(learning_item)
      .where(eq(learning_item.id, record.learning_item_id))
      .limit(1);
    if (li) output.learning_item = { id: li.id, title: li.title, status: li.status };
  }
  if (include.has('knowledge_context')) {
    const paths = await knowledgeContext(ctx.db, record.knowledge_ids ?? []);
    const edges =
      record.knowledge_ids.length > 0
        ? await ctx.db
            .select({
              from: knowledge_edge.from_knowledge_id,
              to: knowledge_edge.to_knowledge_id,
              relation_type: knowledge_edge.relation_type,
              reason: knowledge_edge.reasoning,
            })
            .from(knowledge_edge)
            .where(
              and(isNull(knowledge_edge.archived_at), knowledgeEdgeTouches(record.knowledge_ids)),
            )
        : [];
    output.knowledge_context = {
      paths: paths.map((p) => p.path),
      related_edges: edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        relation_type: edge.relation_type,
        reason: edge.reason ?? '',
      })),
    };
  }
  if (include.has('event_chain') && record.origin_event_id) {
    const [origin] = await ctx.db
      .select()
      .from(event)
      .where(eq(event.id, record.origin_event_id))
      .limit(1);
    const children = await ctx.db
      .select({ id: event.id, action: event.action })
      .from(event)
      .where(eq(event.caused_by_event_id, record.origin_event_id))
      .orderBy(desc(event.created_at))
      .limit(20);
    output.event_chain = { parent: origin?.caused_by_event_id ?? null, children };
  }
  return GetRecordContextOutputSchema.parse(output);
}

const GetQuestionContextInputSchema = z.object({
  questionId: z.string().min(1),
  include: z
    .array(
      z.enum([
        'source',
        'attempts',
        'review_history',
        'fsrs_state',
        'records',
        'variants',
        'knowledge_context',
        'assets',
      ]),
    )
    .optional(),
  attemptLimit: z.number().int().min(1).max(50).optional(),
  reviewLimit: z.number().int().min(1).max(50).optional(),
});

const GetQuestionContextOutputSchema = z.object({
  question: z
    .object({
      id: z.string(),
      prompt_md: z.string(),
      reference_md: z.string().nullable(),
      kind: z.string(),
      knowledge_ids: z.array(z.string()),
      difficulty: z.number().int(),
      source: z.string(),
      source_ref: z.string().nullable(),
      recorded_at: z.string(),
    })
    .nullable(),
  lifecycle: z.object({
    first_attempted_at: z.string().nullable(),
    last_attempted_at: z.string().nullable(),
    attempt_counts: z.object({ success: z.number(), partial: z.number(), failure: z.number() }),
    first_reviewed_at: z.string().nullable(),
    last_reviewed_at: z.string().nullable(),
    review_count: z.number().int(),
    due_at: z.string().nullable(),
    last_review_event_id: z.string().nullable(),
    linked_record_ids: z.array(z.string()),
  }),
  attempts: z
    .array(
      z.object({
        event_id: z.string(),
        outcome: z.string(),
        answer_excerpt: z.string(),
        created_at: z.string(),
      }),
    )
    .optional(),
  review_history: z
    .array(z.object({ event_id: z.string(), fsrs_rating: z.string(), created_at: z.string() }))
    .optional(),
  records: z
    .array(
      z.object({
        record_id: z.string(),
        kind: z.string(),
        excerpt: z.string(),
        created_at: z.string(),
      }),
    )
    .optional(),
  variants: z
    .array(z.object({ question_id: z.string(), draft_status: z.string(), created_at: z.string() }))
    .optional(),
  knowledge_context: z
    .array(
      z.object({
        knowledge_id: z.string(),
        path: z.array(z.string()),
        mastery: z.number().nullable(),
      }),
    )
    .optional(),
  source_assets: z
    .array(z.object({ asset_id: z.string(), role: z.string(), crop_ref: z.string().optional() }))
    .optional(),
});

type GetQuestionContextInput = z.infer<typeof GetQuestionContextInputSchema>;
type GetQuestionContextOutput = z.infer<typeof GetQuestionContextOutputSchema>;

async function executeGetQuestionContext(
  ctx: ToolContext,
  raw: GetQuestionContextInput,
): Promise<GetQuestionContextOutput> {
  const input = GetQuestionContextInputSchema.parse(raw);
  const include = new Set(
    input.include ?? ['attempts', 'review_history', 'fsrs_state', 'records', 'knowledge_context'],
  );
  const [q] = await ctx.db
    .select()
    .from(question)
    .where(eq(question.id, input.questionId))
    .limit(1);
  const records = include.has('records')
    ? await ctx.db
        .select()
        .from(learning_record)
        .where(
          and(
            eq(learning_record.question_id, input.questionId),
            isNull(learning_record.archived_at),
          ),
        )
        .orderBy(desc(learning_record.created_at))
        .limit(25)
    : [];
  const timeline = await getQuestionTimeline(ctx.db, input.questionId, input.attemptLimit ?? 10);
  const reviews = await getRecentReviewEvents(ctx.db, {
    questionIds: [input.questionId],
    limit: input.reviewLimit ?? 10,
  });
  const [fsrs] = await ctx.db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'question'),
        eq(material_fsrs_state.subject_id, input.questionId),
      ),
    )
    .limit(1);
  const attempts = timeline.filter((entry) => entry.kind === 'attempt');
  const reviewEntries = timeline.filter((entry) => entry.kind === 'review');
  const attemptCounts = { success: 0, partial: 0, failure: 0 };
  for (const attempt of attempts) {
    if (attempt.outcome === 'success') attemptCounts.success += 1;
    else if (attempt.outcome === 'partial') attemptCounts.partial += 1;
    else attemptCounts.failure += 1;
  }

  const output: GetQuestionContextOutput = {
    question: q
      ? {
          id: q.id,
          prompt_md: q.prompt_md,
          reference_md: q.reference_md ?? null,
          kind: q.kind,
          knowledge_ids: q.knowledge_ids ?? [],
          difficulty: q.difficulty,
          source: q.source,
          source_ref: q.source_ref ?? null,
          recorded_at: q.created_at.toISOString(),
        }
      : null,
    lifecycle: {
      first_attempted_at: iso(attempts.at(-1)?.created_at),
      last_attempted_at: iso(attempts[0]?.created_at),
      attempt_counts: attemptCounts,
      first_reviewed_at: iso(reviewEntries.at(-1)?.created_at ?? reviews.at(-1)?.created_at),
      last_reviewed_at: iso(reviewEntries[0]?.created_at ?? reviews[0]?.created_at),
      review_count: reviews.length,
      due_at: iso(fsrs?.due_at),
      last_review_event_id: fsrs?.last_review_event_id ?? null,
      linked_record_ids: records.map((row) => row.id),
    },
  };
  if (include.has('attempts')) {
    output.attempts = attempts.map((entry) => ({
      event_id: entry.event_id,
      outcome: entry.outcome,
      answer_excerpt: '',
      created_at: entry.created_at.toISOString(),
    }));
  }
  if (include.has('review_history')) {
    output.review_history = reviews.map((review) => ({
      event_id: review.review_event_id,
      fsrs_rating: review.fsrs_rating,
      created_at: review.created_at.toISOString(),
    }));
  }
  if (include.has('records')) {
    output.records = records.map((row) => ({
      record_id: row.id,
      kind: row.kind,
      excerpt: excerpt(row.content_md),
      created_at: row.created_at.toISOString(),
    }));
  }
  if (include.has('variants')) {
    const variants = await ctx.db
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.parent_question_id, input.questionId))
      .orderBy(desc(mistake_variant.created_at))
      .limit(20);
    output.variants = variants.map((variant) => ({
      question_id: variant.variant_question_id ?? variant.id,
      draft_status: variant.status,
      created_at: variant.created_at.toISOString(),
    }));
  }
  if (include.has('knowledge_context') && q) {
    output.knowledge_context = await knowledgeContext(ctx.db, q.knowledge_ids ?? []);
  }
  if (include.has('assets') && q) {
    output.source_assets = [
      ...(q.image_refs ?? []).map((id) => ({ asset_id: id, role: 'question_image' })),
      ...(q.figures ?? []).map((fig, index) => ({
        asset_id: fig.asset_id ?? `figure_${index}`,
        role: fig.role ?? 'figure',
      })),
    ];
  }
  return GetQuestionContextOutputSchema.parse(output);
}

const GetReviewDueInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  knowledgeIds: z.array(z.string()).optional(),
  causes: z.array(z.string()).optional(),
  includeReason: z.boolean().optional(),
});

const GetReviewDueOutputSchema = z.object({
  rows: z.array(
    z.object({
      question_id: z.string(),
      prompt_excerpt: z.string(),
      knowledge_ids: z.array(z.string()),
      fsrs_state: z.unknown().nullable(),
      due_at: z.string().nullable(),
      reason: z.enum(['never_reviewed_failure', 'overdue', 'filtered_match']),
      latest_mistake: z
        .object({
          attempt_event_id: z.string(),
          cause: z.string().nullable(),
          created_at: z.string(),
        })
        .optional(),
    }),
  ),
  queue_summary: z.object({
    total_returned: z.number().int(),
    never_reviewed_count: z.number().int(),
    overdue_count: z.number().int(),
    top_knowledge_ids: z.array(z.string()),
  }),
});

type GetReviewDueInput = z.infer<typeof GetReviewDueInputSchema>;
type GetReviewDueOutput = z.infer<typeof GetReviewDueOutputSchema>;

// Exported so non-LLM read paths (e.g. /api/today/copilot-summary in Wave 5)
// can reuse the exact predicate without duplicating SQL. Pass a minimal
// ToolContext (`{ db, taskRunId: 'system', callerActor: ... }`) when calling
// from a non-MCP surface; no events are written by this function.
export async function executeGetReviewDue(
  ctx: ToolContext,
  raw: GetReviewDueInput,
): Promise<GetReviewDueOutput> {
  const input = GetReviewDueInputSchema.parse(raw);
  const limit = input.limit ?? 20;
  const now = new Date();
  type DueRow = {
    question_id: string;
    state: unknown;
    due_at: Date;
    prompt_md: string;
    knowledge_ids: string[];
  };
  const dueRows: DueRow[] = [];
  const usedDueQuestionIds = new Set<string>();
  const knowledgeStateConditions = [
    eq(material_fsrs_state.subject_kind, 'knowledge'),
    lte(material_fsrs_state.due_at, now),
  ];
  if (input.knowledgeIds?.length) {
    knowledgeStateConditions.push(inArray(material_fsrs_state.subject_id, input.knowledgeIds));
  }
  const dueKnowledgeStates = await ctx.db
    .select({
      knowledge_id: material_fsrs_state.subject_id,
      state: material_fsrs_state.state,
      due_at: material_fsrs_state.due_at,
    })
    .from(material_fsrs_state)
    .where(and(...knowledgeStateConditions))
    .orderBy(asc(material_fsrs_state.due_at), asc(material_fsrs_state.subject_id))
    .limit(limit);

  for (const due of dueKnowledgeStates) {
    const qRows = await ctx.db
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        knowledge_ids: question.knowledge_ids,
        created_at: question.created_at,
      })
      .from(question)
      .where(
        and(
          sql`${question.knowledge_ids} @> ${JSON.stringify([due.knowledge_id])}::jsonb`,
          sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
        ),
      )
      .orderBy(asc(question.created_at), asc(question.id))
      .limit(10);
    const selected = qRows.find((row) => !usedDueQuestionIds.has(row.id));
    if (!selected) continue;
    usedDueQuestionIds.add(selected.id);
    dueRows.push({
      question_id: selected.id,
      state: due.state,
      due_at: due.due_at,
      prompt_md: selected.prompt_md,
      knowledge_ids: selected.knowledge_ids ?? [],
    });
  }

  const legacyQuestionConditions = [
    eq(material_fsrs_state.subject_kind, 'question'),
    lte(material_fsrs_state.due_at, now),
    // Guard-B (codex PR #298 #3357817910): a legacy/mis-written
    // material_fsrs_state row keyed on a question whose question is still
    // draft_status='draft' must NEVER enter the candidate pool. The knowledge
    // branch above already inlines this exclusion; the public due-list path
    // (`notDraftQuiz` in src/server/review/due-list.ts) adds it on its own
    // legacy-question join. This branch was the one place missing it, so every
    // get_review_due consumer (snapshot / candidates / non-LLM read paths)
    // could surface a draft question. NULL handling is explicit: only 'draft'
    // is excluded (`draft_status <> 'draft'` alone would drop NULL rows under
    // SQL three-valued logic).
    sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
  ];
  if (input.knowledgeIds?.length) {
    legacyQuestionConditions.push(questionKnowledgeContainsAny(input.knowledgeIds));
  }
  const legacyDueRows = await ctx.db
    .select({
      question_id: material_fsrs_state.subject_id,
      state: material_fsrs_state.state,
      due_at: material_fsrs_state.due_at,
      prompt_md: question.prompt_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(material_fsrs_state)
    .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
    .where(and(...legacyQuestionConditions))
    .orderBy(asc(material_fsrs_state.due_at), asc(question.created_at))
    .limit(limit);
  for (const due of legacyDueRows) {
    if (usedDueQuestionIds.has(due.question_id)) continue;
    usedDueQuestionIds.add(due.question_id);
    dueRows.push(due);
  }
  dueRows.sort((a, b) => {
    const dueDelta = a.due_at.getTime() - b.due_at.getTime();
    if (dueDelta !== 0) return dueDelta;
    return a.question_id.localeCompare(b.question_id);
  });

  const fsrsSubjectRows = await ctx.db
    .select({
      subject_kind: material_fsrs_state.subject_kind,
      subject_id: material_fsrs_state.subject_id,
    })
    .from(material_fsrs_state)
    .where(
      or(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        eq(material_fsrs_state.subject_kind, 'question'),
      ),
    );
  const existingKnowledgeFsrsIds = new Set(
    fsrsSubjectRows.filter((row) => row.subject_kind === 'knowledge').map((row) => row.subject_id),
  );
  const existingQuestionFsrsIds = new Set(
    fsrsSubjectRows.filter((row) => row.subject_kind === 'question').map((row) => row.subject_id),
  );
  const failures = await getFailureAttempts(ctx.db, { limit: 200 });
  const latestNeverReviewed = new Map<string, (typeof failures)[number]>();
  for (const failure of failures) {
    const knowledgeReviewed = failure.referenced_knowledge_ids.some((id) =>
      existingKnowledgeFsrsIds.has(id),
    );
    if (knowledgeReviewed || existingQuestionFsrsIds.has(failure.question_id)) continue;
    if (
      input.knowledgeIds?.length &&
      !input.knowledgeIds.some((id) => failure.referenced_knowledge_ids.includes(id))
    ) {
      continue;
    }
    const cause = effectiveCauseForFailureAttempt(failure);
    if (input.causes?.length && (!cause || !input.causes.includes(cause.primary_category)))
      continue;
    if (!latestNeverReviewed.has(failure.question_id))
      latestNeverReviewed.set(failure.question_id, failure);
  }
  const newQuestionIds = [...latestNeverReviewed.keys()].slice(0, limit);
  const newQuestions =
    newQuestionIds.length > 0
      ? await ctx.db
          .select()
          .from(question)
          .where(
            and(
              inArray(question.id, newQuestionIds),
              // Guard-B (codex PR #298 #3357932403): a draft question with a
              // failure attempt has NO material_fsrs_state row, so the FSRS-keyed
              // branches' draft filter above never sees it — it would otherwise
              // surface here as a never-reviewed-failure candidate. Apply the same
              // exclusion the due-list.ts public path applies to its never-
              // reviewed slice. NULL handling explicit: only 'draft' excluded.
              sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
            ),
          )
      : [];
  const qById = new Map(newQuestions.map((row) => [row.id, row]));

  const rows: GetReviewDueOutput['rows'] = [];
  for (const qid of newQuestionIds) {
    const q = qById.get(qid);
    const failure = latestNeverReviewed.get(qid);
    if (!q || !failure) continue;
    const cause = effectiveCauseForFailureAttempt(failure);
    rows.push({
      question_id: q.id,
      prompt_excerpt: excerpt(q.prompt_md),
      knowledge_ids: q.knowledge_ids ?? [],
      fsrs_state: null,
      due_at: null,
      reason: 'never_reviewed_failure',
      latest_mistake: {
        attempt_event_id: failure.attempt_event_id,
        cause: cause?.primary_category ?? null,
        created_at: failure.created_at.toISOString(),
      },
    });
  }
  for (const due of dueRows) {
    if (rows.length >= limit) break;
    rows.push({
      question_id: due.question_id,
      prompt_excerpt: excerpt(due.prompt_md),
      knowledge_ids: due.knowledge_ids ?? [],
      fsrs_state: due.state,
      due_at: due.due_at.toISOString(),
      reason: 'overdue',
    });
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const id of row.knowledge_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return GetReviewDueOutputSchema.parse({
    rows,
    queue_summary: {
      total_returned: rows.length,
      never_reviewed_count: rows.filter((row) => row.reason === 'never_reviewed_failure').length,
      overdue_count: rows.filter((row) => row.reason === 'overdue').length,
      top_knowledge_ids: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id)
        .slice(0, 5),
    },
  });
}

const GetLearningItemInputSchema = z.object({
  learningItemId: z.string().min(1),
  include: z
    .array(
      z.enum([
        'parent',
        'children',
        'primary_artifact',
        'completion_evidence',
        'recent_events',
        'records',
        'knowledge_context',
      ]),
    )
    .optional(),
});

const GetLearningItemOutputSchema = z.object({
  item: z
    .object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      status: z.string(),
      knowledge_ids: z.array(z.string()),
      primary_artifact_id: z.string().nullable(),
      parent_learning_item_id: z.string().nullable(),
    })
    .nullable(),
  hierarchy: z
    .object({
      parent: z.object({ id: z.string(), title: z.string(), status: z.string() }).optional(),
      children: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          knowledge_ids: z.array(z.string()),
        }),
      ),
    })
    .optional(),
  primary_artifact: z
    .object({
      id: z.string(),
      type: z.string(),
      generation_status: z.string(),
      section_summaries: z.array(z.string()),
    })
    .optional(),
  evidence: z
    .array(
      z.object({ id: z.string(), path: z.string(), summary: z.string(), created_at: z.string() }),
    )
    .optional(),
  recent_activity: z
    .array(
      z.object({
        kind: z.enum(['event', 'learning_record']),
        id: z.string(),
        summary: z.string(),
        created_at: z.string(),
      }),
    )
    .optional(),
  knowledge_context: z
    .array(
      z.object({
        knowledge_id: z.string(),
        path: z.array(z.string()),
        mastery: z.number().nullable(),
      }),
    )
    .optional(),
});

type GetLearningItemInput = z.infer<typeof GetLearningItemInputSchema>;
type GetLearningItemOutput = z.infer<typeof GetLearningItemOutputSchema>;

async function executeGetLearningItemContext(
  ctx: ToolContext,
  raw: GetLearningItemInput,
): Promise<GetLearningItemOutput> {
  const input = GetLearningItemInputSchema.parse(raw);
  const include = new Set(
    input.include ?? [
      'parent',
      'children',
      'primary_artifact',
      'recent_events',
      'records',
      'knowledge_context',
    ],
  );
  const [item] = await ctx.db
    .select()
    .from(learning_item)
    .where(eq(learning_item.id, input.learningItemId))
    .limit(1);
  if (!item) return GetLearningItemOutputSchema.parse({ item: null });
  const output: GetLearningItemOutput = {
    item: {
      id: item.id,
      title: item.title,
      content: item.content,
      status: item.status,
      knowledge_ids: item.knowledge_ids ?? [],
      primary_artifact_id: item.primary_artifact_id ?? null,
      parent_learning_item_id: item.parent_learning_item_id ?? null,
    },
  };
  if (include.has('parent') || include.has('children')) {
    const hierarchy: NonNullable<GetLearningItemOutput['hierarchy']> = { children: [] };
    if (include.has('parent') && item.parent_learning_item_id) {
      const [parent] = await ctx.db
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, item.parent_learning_item_id))
        .limit(1);
      if (parent) hierarchy.parent = { id: parent.id, title: parent.title, status: parent.status };
    }
    if (include.has('children')) {
      const children = await ctx.db
        .select()
        .from(learning_item)
        .where(eq(learning_item.parent_learning_item_id, item.id))
        .orderBy(asc(learning_item.created_at))
        .limit(50);
      hierarchy.children = children.map((child) => ({
        id: child.id,
        title: child.title,
        status: child.status,
        knowledge_ids: child.knowledge_ids ?? [],
      }));
    }
    output.hierarchy = hierarchy;
  }
  if (include.has('primary_artifact') && item.primary_artifact_id) {
    const [a] = await ctx.db
      .select()
      .from(artifact)
      .where(eq(artifact.id, item.primary_artifact_id))
      .limit(1);
    if (a) {
      output.primary_artifact = {
        id: a.id,
        type: a.type,
        generation_status: a.generation_status,
        section_summaries: bodyBlockSummaries(a.body_blocks),
      };
    }
  }
  if (include.has('completion_evidence')) {
    const evidence = await ctx.db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, item.id))
      .orderBy(desc(completion_evidence.decided_at))
      .limit(20);
    output.evidence = evidence.map((row) => ({
      id: row.id,
      path: row.path,
      summary: excerpt(JSON.stringify(row.evidence_json), 160),
      created_at: row.decided_at.toISOString(),
    }));
  }
  const recentActivity: NonNullable<GetLearningItemOutput['recent_activity']> = [];
  if (include.has('recent_events')) {
    const subjectCondition = item.primary_artifact_id
      ? or(eq(event.subject_id, item.id), eq(event.subject_id, item.primary_artifact_id))
      : eq(event.subject_id, item.id);
    const events = await ctx.db
      .select()
      .from(event)
      .where(subjectCondition)
      .orderBy(desc(event.created_at))
      .limit(10);
    recentActivity.push(
      ...events.map((row) => ({
        kind: 'event' as const,
        id: row.id,
        summary: `${row.action}/${row.subject_kind}/${row.outcome ?? 'n/a'}`,
        created_at: row.created_at.toISOString(),
      })),
    );
  }
  if (include.has('records')) {
    const records = await ctx.db
      .select()
      .from(learning_record)
      .where(
        and(eq(learning_record.learning_item_id, item.id), isNull(learning_record.archived_at)),
      )
      .orderBy(desc(learning_record.created_at))
      .limit(10);
    recentActivity.push(
      ...records.map((row) => ({
        kind: 'learning_record' as const,
        id: row.id,
        summary: `${row.kind}: ${excerpt(row.content_md, 140)}`,
        created_at: row.created_at.toISOString(),
      })),
    );
  }
  if (recentActivity.length > 0) {
    output.recent_activity = recentActivity
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 15);
  }
  if (include.has('knowledge_context')) {
    output.knowledge_context = await knowledgeContext(ctx.db, item.knowledge_ids ?? []);
  }
  return GetLearningItemOutputSchema.parse(output);
}

const MemoryBriefInputSchema = z.object({
  scopeKey: z.string().optional(),
  includeEvidence: z.boolean().optional(),
});

const MemoryBriefOutputSchema = z.object({
  note: z
    .object({
      id: z.string(),
      scope_key: z.string(),
      subject_id: z.string().nullable(),
      recent_week_md: z.string(),
      recent_months_md: z.string(),
      long_term_md: z.string(),
      // P5.3 (YUK-183) — additive-optional evidence-decay freshness score for
      // long_term_md. null = unjudgeable. Advisory render-annotation signal only;
      // not evidence-gated (a scalar score is not provenance). Spec §7.2.
      long_term_freshness_score: z.number().nullable().optional(),
      refreshed_at: z.string().nullable(),
      source_event_id: z.string().nullable(),
      version: z.number().int(),
    })
    .nullable(),
  evidence: z
    .object({
      recent_week_ids: z.array(z.string()),
      recent_months_ids: z.array(z.string()),
      long_term_ids: z.array(z.string()),
    })
    .optional(),
});

type MemoryBriefInput = z.infer<typeof MemoryBriefInputSchema>;
type MemoryBriefOutput = z.infer<typeof MemoryBriefOutputSchema>;

// Exported alongside `executeGetReviewDue` so the Copilot Drawer summary
// (Wave 5 / T-D3/B) can read the memory_brief_note row directly without
// mirroring the SQL or going through the MCP bridge. No event side effects.
export async function executeMemoryBrief(
  ctx: ToolContext,
  raw: MemoryBriefInput,
): Promise<MemoryBriefOutput> {
  const input = MemoryBriefInputSchema.parse(raw);
  const scopeKey = input.scopeKey ?? 'global';
  const [note] = await ctx.db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  if (!note) return MemoryBriefOutputSchema.parse({ note: null });
  return MemoryBriefOutputSchema.parse({
    note: {
      id: note.id,
      scope_key: note.scope_key,
      subject_id: note.subject_id ?? null,
      recent_week_md: note.recent_week_md,
      recent_months_md: note.recent_months_md,
      long_term_md: note.long_term_md,
      long_term_freshness_score: note.long_term_freshness_score ?? null, // P5.3 (§7.2)
      refreshed_at: iso(note.refreshed_at),
      source_event_id: note.source_event_id ?? null,
      version: note.version,
    },
    ...(input.includeEvidence
      ? {
          evidence: {
            recent_week_ids: note.recent_week_evidence_ids ?? [],
            recent_months_ids: note.recent_months_evidence_ids ?? [],
            long_term_ids: note.long_term_evidence_ids ?? [],
          },
        }
      : {}),
  });
}

export const queryRecordsTool: DomainTool<QueryRecordsInput, QueryRecordsOutput> = {
  name: 'query_records',
  description:
    'Read activity-grounded LearningRecord rows with bounded filters for kind, knowledge, question, attempt, item, and text.',
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

export const getRecordContextTool: DomainTool<GetRecordContextInput, GetRecordContextOutput> = {
  name: 'get_record_context',
  description:
    'Read one LearningRecord end-to-end, including linked question, attempt, attribution, artifact, item, graph paths, and event chain.',
  effect: 'read',
  inputSchema: GetRecordContextInputSchema,
  outputSchema: GetRecordContextOutputSchema,
  costClass: 'local',
  execute: executeGetRecordContext,
  summarize(input, output) {
    return `record context · ${input.recordId} · ${output.record?.kind ?? 'missing'}`;
  },
  mirrorEvent: 'when_user_visible',
};

export const getQuestionContextTool: DomainTool<GetQuestionContextInput, GetQuestionContextOutput> =
  {
    name: 'get_question_context',
    description:
      'Read one question contract plus attempts, reviews, FSRS state, linked records, variants, knowledge paths, and assets.',
    effect: 'read',
    inputSchema: GetQuestionContextInputSchema,
    outputSchema: GetQuestionContextOutputSchema,
    costClass: 'local',
    execute: executeGetQuestionContext,
    summarize(input, output) {
      return `question context · ${input.questionId} · attempts=${Object.values(output.lifecycle.attempt_counts).reduce((a, b) => a + b, 0)} · reviews=${output.lifecycle.review_count}`;
    },
    mirrorEvent: 'when_user_visible',
  };

export const getReviewDueTool: DomainTool<GetReviewDueInput, GetReviewDueOutput> = {
  name: 'get_review_due',
  description:
    'Read the deterministic review-due queue: never-reviewed failure attempts first, then overdue FSRS cards. Never mutates FSRS.',
  effect: 'read',
  inputSchema: GetReviewDueInputSchema,
  outputSchema: GetReviewDueOutputSchema,
  costClass: 'local',
  execute: executeGetReviewDue,
  summarize(_input, output) {
    return `review due · ${output.queue_summary.total_returned} rows · ${output.queue_summary.never_reviewed_count} new · ${output.queue_summary.overdue_count} overdue`;
  },
  mirrorEvent: 'when_user_visible',
};

export const getLearningItemContextTool: DomainTool<GetLearningItemInput, GetLearningItemOutput> = {
  name: 'get_learning_item_context',
  description:
    'Read one LearningItem with hierarchy, primary artifact summary, completion evidence, recent activity, and knowledge paths.',
  effect: 'read',
  inputSchema: GetLearningItemInputSchema,
  outputSchema: GetLearningItemOutputSchema,
  costClass: 'local',
  execute: executeGetLearningItemContext,
  summarize(input, output) {
    return `learning item · ${input.learningItemId} · ${output.item?.status ?? 'missing'} · activity=${output.recent_activity?.length ?? 0}`;
  },
  mirrorEvent: 'when_user_visible',
};

export const queryMemoryBriefTool: DomainTool<MemoryBriefInput, MemoryBriefOutput> = {
  name: 'query_memory_brief',
  description:
    'Read the current Dreaming-maintained memory brief note for global or subject scope, with optional evidence ids.',
  effect: 'read',
  inputSchema: MemoryBriefInputSchema,
  outputSchema: MemoryBriefOutputSchema,
  costClass: 'local',
  execute: executeMemoryBrief,
  summarize(input, output) {
    return output.note
      ? `memory brief · ${input.scopeKey ?? 'global'} · v${output.note.version}`
      : `memory brief · ${input.scopeKey ?? 'global'} · none`;
  },
  mirrorEvent: 'when_user_visible',
};
