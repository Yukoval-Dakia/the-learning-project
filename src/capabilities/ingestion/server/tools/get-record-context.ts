import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  artifact,
  event,
  knowledge_edge,
  learning_item,
  learning_record,
  question,
} from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import { bodyBlockSummaries, knowledgeContext, knowledgeEdgeTouches } from './record-tool-support';
import type { DomainTool, ToolContext } from './types';

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
    const [linkedQuestion] = await ctx.db
      .select()
      .from(question)
      .where(eq(question.id, record.question_id))
      .limit(1);
    if (linkedQuestion) {
      output.question = {
        id: linkedQuestion.id,
        prompt_md: linkedQuestion.prompt_md,
        reference_md: linkedQuestion.reference_md ?? null,
        knowledge_ids: linkedQuestion.knowledge_ids ?? [],
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
    const [linkedArtifact] = await ctx.db
      .select()
      .from(artifact)
      .where(eq(artifact.id, record.artifact_id))
      .limit(1);
    if (linkedArtifact) {
      output.artifact = {
        id: linkedArtifact.id,
        type: linkedArtifact.type,
        summary: bodyBlockSummaries(linkedArtifact.body_blocks).join(' | ') || linkedArtifact.title,
      };
    }
  }
  if (include.has('learning_item') && record.learning_item_id) {
    const [item] = await ctx.db
      .select()
      .from(learning_item)
      .where(eq(learning_item.id, record.learning_item_id))
      .limit(1);
    if (item) output.learning_item = { id: item.id, title: item.title, status: item.status };
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
      paths: paths.map((path) => path.path),
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
