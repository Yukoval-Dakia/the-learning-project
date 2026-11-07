// One knowledge point: the published judgment plus the shared cause reading.
// id and name are exact and mutually exclusive. An unresolved point stays unknown.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { A5_BANDS } from '@/core/mastery-band';
import type { KnowledgeSignal } from '@/core/schema/knowledge-signal';
import { unknownSignal } from '@/core/schema/knowledge-signal';
import { knowledge } from '@/db/schema';
import { readCauseJudgment } from '@/kernel/read-models/cause-judgment';
import {
  type DecayBand,
  type KnowledgeStateProjection,
  projectKnowledgeState,
} from '@/kernel/read-models/knowledge-state';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import type { DomainTool, ToolContext } from './types';

const RESOLVE_SOURCE = 'capabilities/knowledge/server/tools/knowledge-state:resolveKnowledge';
const MATCH_LIMIT = 8;

const InputSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional().describe('知识点 id'),
    name: z.string().trim().min(1).max(80).optional().describe('知识点名称，精确匹配'),
  })
  .strict();

const TopCauseSchema = z.object({
  category: z.string(),
  label: z.string().nullable(),
  count: z.number().int().nonnegative(),
  last_at: z.string(),
});

function signalSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    known: z.boolean(),
    source: z.string(),
    asOf: z.string(),
    missingReason: z.string().nullable(),
  });
}

const OutputSchema = z.object({
  status: z.enum(['ready', 'not_found', 'ambiguous', 'invalid_selector']),
  knowledge_id: z.string().nullable(),
  name: z.string().nullable(),
  matches: z.array(z.object({ id: z.string(), name: z.string() })),
  band: signalSchema(z.enum(A5_BANDS)),
  evidence_count: signalSchema(z.number().int().nonnegative()),
  decay: signalSchema(z.enum(['untrained', 'fresh', 'mild', 'stale'])),
  due_at: signalSchema(z.string()),
  consecutive_errors: signalSchema(z.number().int().nonnegative()),
  top_causes: signalSchema(z.array(TopCauseSchema)),
  retention: signalSchema(z.number()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function blank<T>(asOf: Date, reason: string): KnowledgeSignal<T> {
  return unknownSignal<T>(RESOLVE_SOURCE, asOf, reason);
}

function unresolved(status: Output['status'], asOf: Date, reason: string): Output {
  return {
    status,
    knowledge_id: null,
    name: null,
    matches: [],
    band: blank(asOf, reason),
    evidence_count: blank(asOf, reason),
    decay: blank(asOf, reason),
    due_at: blank(asOf, reason),
    consecutive_errors: blank(asOf, reason),
    top_causes: blank(asOf, reason),
    retention: blank(asOf, reason),
  };
}

async function resolveKnowledge(
  ctx: ToolContext,
  input: Input,
): Promise<
  | { status: 'ready'; id: string; name: string }
  | { status: 'not_found' | 'ambiguous' | 'invalid_selector'; matches: Output['matches'] }
> {
  const hasId = input.id !== undefined;
  const hasName = input.name !== undefined;
  if (hasId === hasName) return { status: 'invalid_selector', matches: [] };
  if (input.id) {
    const rows = await ctx.db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(and(eq(knowledge.id, input.id), isNull(knowledge.archived_at)))
      .limit(1);
    const row = rows.find((candidate) => isLearnerVisibleKnowledgeId(candidate.id));
    return row
      ? { status: 'ready', id: row.id, name: row.name }
      : { status: 'not_found', matches: [] };
  }
  const rows = await ctx.db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(eq(knowledge.name, input.name ?? ''), isNull(knowledge.archived_at)))
    .orderBy(asc(knowledge.id))
    .limit(MATCH_LIMIT + 1);
  const visible = rows.filter((row) => isLearnerVisibleKnowledgeId(row.id));
  const only = visible[0];
  if (!only) return { status: 'not_found', matches: [] };
  if (visible.length > 1) {
    return { status: 'ambiguous', matches: visible.slice(0, MATCH_LIMIT) };
  }
  return { status: 'ready', id: only.id, name: only.name };
}

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const asOf = new Date();
  const resolved = await resolveKnowledge(ctx, input);
  if (resolved.status !== 'ready') {
    const reason =
      resolved.status === 'invalid_selector' ? 'id_or_name_required' : 'knowledge_not_resolved';
    const body = unresolved(resolved.status, asOf, reason);
    return OutputSchema.parse({ ...body, matches: resolved.matches });
  }
  const judgmentBatch = await ctx.db.transaction(
    async (tx) => {
      const batch = await readLearnerJudgments(tx, {
        knowledge_ids: [resolved.id],
        context: 'any',
        as_of: asOf,
      });
      const causes = await readCauseJudgment(tx, {
        knowledge_ids: [resolved.id],
        as_of: asOf,
      });
      return { batch, causes };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const judgment = judgmentBatch.batch.items.find((item) => item.knowledge_id === resolved.id);
  const cause = judgmentBatch.causes.items.find((item) => item.knowledge_id === resolved.id);
  const projected: KnowledgeStateProjection = judgment
    ? projectKnowledgeState(judgment, asOf)
    : {
        band: blank(asOf, 'learner_judgment_missing'),
        evidence_count: blank(asOf, 'learner_judgment_missing'),
        decay: blank<DecayBand>(asOf, 'learner_judgment_missing'),
        due_at: blank(asOf, 'learner_judgment_missing'),
        retention: blank(asOf, 'learner_judgment_missing'),
      };
  return OutputSchema.parse({
    status: 'ready',
    knowledge_id: resolved.id,
    name: resolved.name,
    matches: [],
    ...projected,
    consecutive_errors: cause?.consecutive_errors ?? blank(asOf, 'cause_judgment_missing'),
    top_causes: cause?.top_causes ?? blank(asOf, 'cause_judgment_missing'),
  });
}

export const getKnowledgeStateTool: DomainTool<Input, Output> = {
  name: 'get_knowledge_state',
  description:
    'Read one knowledge point by id or exact name: band, evidence, decay, due, error streak, top causes, retention.',
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize(_input, output) {
    const who = output.name ?? output.knowledge_id ?? output.status;
    const band = output.band.known ? output.band.value : '未知';
    return `knowledge state · ${who} · ${band}`;
  },
  mirrorEvent: 'when_user_visible',
};
