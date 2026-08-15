import { bodyBlockSummaries, excerpt, knowledgeContext } from '@/capabilities/ingestion/public';
import { artifact, completion_evidence, event, learning_item, learning_record } from '@/db/schema';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

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
    const [primaryArtifact] = await ctx.db
      .select()
      .from(artifact)
      .where(eq(artifact.id, item.primary_artifact_id))
      .limit(1);
    if (primaryArtifact) {
      output.primary_artifact = {
        id: primaryArtifact.id,
        type: primaryArtifact.type,
        generation_status: primaryArtifact.generation_status,
        section_summaries: bodyBlockSummaries(primaryArtifact.body_blocks),
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
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 15);
  }
  if (include.has('knowledge_context')) {
    output.knowledge_context = await knowledgeContext(ctx.db, item.knowledge_ids ?? []);
  }
  return GetLearningItemOutputSchema.parse(output);
}

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
