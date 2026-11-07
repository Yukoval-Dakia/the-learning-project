// query_mistakes: summarized recent failure attempts with optional cause, review-state, and
// variant joins, so copilot and dreaming can read struggles without scanning raw events.

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { material_fsrs_state, mistake_variant, question } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  type FailureAttempt,
  getFailureAttemptsForDerivation,
} from '@/kernel/read-models/failure-attempts';
import { loadFailureLearningKnowledgeContext } from '@/kernel/read-models/failure-learning-context';
import { miscCauseLabelMap, resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
// P5.1 / — snippet cap + courtesy default sourced from budgets.ts.
// Both are byte-unchanged from the prior file-local literals (160 / 20).
import { MISTAKE_PROMPT_SNIPPET_MAX, TOOL_COURTESY_DEFAULTS } from '@/kernel/tools/budgets';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';

const PROMPT_SNIPPET_MAX = MISTAKE_PROMPT_SNIPPET_MAX;

const InputSchema = z.object({
  filter: z
    .object({
      causeCategoryId: z.string().optional(),
      knowledgeId: z.string().optional(),
      dueWithinDays: z.number().int().nonnegative().max(90).optional(),
      sinceDays: z.number().int().positive().max(180).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  includeVariants: z.boolean().optional(),
  includeAttribution: z.boolean().optional(),
});

const CauseSchema = z.object({
  source: z.enum(['user', 'agent']),
  primary_category: z.string(),
  // misc_ id 的显示回填（active misconception title）；非 misc /
  // unresolvable → null。
  primary_label: z.string().nullable(),
  // 副归因 id（CauseSchema 语义身份）+ misc_ id 显示回填
  // （id→title map；vocab / unresolvable 缺席 → 消费侧回退裸 id）。
  secondary_categories: z.array(z.string()),
  secondary_labels: z.record(z.string(), z.string()),
  analysis_md: z.string().nullable(),
  user_notes: z.string().nullable(),
  confidence: z.number().nullable(),
});

const ReviewStateSchema = z.object({
  due_at: z.string(),
  is_due: z.boolean(),
});

const VariantSchema = z.object({
  id: z.string(),
  status: z.string(),
});

// Exactly the ChartBlock.series shape so data_source.path can point straight at
// an aggregate. One series keeps the wire small; points are [human label, count].
const AggregateSeriesSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(40),
        points: z.array(z.tuple([z.string(), z.number().int().nonnegative()])).max(500),
      })
      .strict(),
  )
  .max(1);

const AggregatesSchema = z
  .object({
    /** Failed attempts the series cover (the returned row window). */
    counted: z.number().int().nonnegative(),
    /** More matching attempts exist beyond the returned limit. */
    truncated: z.boolean(),
    /** Human cause labels; no cause is 「未分类」. Absent when attribution was not loaded. */
    by_cause: AggregateSeriesSchema.optional(),
    /** Knowledge-point names, one count per referenced point on a failed attempt. */
    by_knowledge: AggregateSeriesSchema,
  })
  .strict();

const MistakeRowSchema = z.object({
  event_id: z.string(),
  question_id: z.string(),
  prompt_snippet: z.string(),
  attempted_at: z.string(),
  cause: CauseSchema.nullable(),
  review_state: ReviewStateSchema.nullable(),
  variants: z.array(VariantSchema).optional(),
  knowledge_ids: z.array(z.string()),
});

const OutputSchema = z.object({
  mistakes: z.array(MistakeRowSchema),
  total: z.number().int().nonnegative(),
  filter_applied: z.object({
    cause: z.string().nullable(),
    knowledge: z.string().nullable(),
    due_within_days: z.number().nullable(),
    since_days: z.number().nullable(),
    limit: z.number().int(),
  }),
  /** ChartBlock.series aggregates over the returned window; coverage is explicit. */
  aggregates: AggregatesSchema,
  /** JSON Pointer paths this result declares as chart-bindable (producer allowlist). */
  chart_bindings: z.array(z.string()).max(8),
  /** What a bound chart covers, in the learner's words; replaces any caption the model wrote. */
  chart_caption: z.string().max(200),
  claim_boundaries: z.object({
    zero_rows_scope: z.literal('matching_failure_attempt_rows_only'),
    supports_entity_inventory_claim: z.literal(false),
    supports_lifecycle_status_count_claim: z.literal(false),
  }),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'Read recent failure attempts (mistakes) with optional cause / review-state / variant joins.',
  'Use this instead of scanning the event table when the user asks "what am I getting wrong" or',
  'when Dreaming / Coach orchestrators need a ranked candidate list.',
  '',
  'Filters compose AND-style:',
  '- filter.causeCategoryId: keep only mistakes whose effective cause (user > agent) matches.',
  '- filter.knowledgeId: keep only mistakes whose attempt event referenced this knowledge node.',
  '- filter.dueWithinDays: keep only mistakes whose FSRS card is due within N days (≤90).',
  '- filter.sinceDays: only consider attempts created within the last N days (≤180).',
  '- filter.limit: 1–50, default 20.',
  '',
  'Set includeVariants=true to also list mistake_variant rows per question.',
  'Set includeAttribution=false to skip the cause-policy resolution (cheaper).',
  'A zero-row result only describes matching failure-attempt rows. It cannot prove a current queue',
  'or entity failed-status count of zero, and cannot override get_review_due.queue_assertion nulls.',
  '',
  'aggregates.by_cause and aggregates.by_knowledge are ChartBlock series over the returned rows:',
  'x is the human cause label / knowledge-point name, y is the number of failed attempts.',
  '`counted` is how many attempts the series cover; `truncated` means more matching attempts exist',
  'beyond the returned limit, so the series describe a recent window, not the whole history.',
  'These are wrong-answer counts, never the due-review queue size.',
  'by_cause is absent when includeAttribution=false (no cause was loaded).',
  'Bind a chart to them with data_source.path=/aggregates/by_cause or /aggregates/by_knowledge.',
  'chart_bindings lists the paths this result declares as chart-bindable.',
  'chart_caption is the coverage line the server puts under a bound chart, replacing any caption you wrote.',
].join('\n');

async function loadQuestionPrompts(db: Db, questionIds: string[]): Promise<Map<string, string>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({ id: question.id, prompt_md: question.prompt_md })
    .from(question)
    .where(inArray(question.id, questionIds));
  return new Map(rows.map((r) => [r.id, r.prompt_md]));
}

async function loadFsrsStates(
  db: Db,
  failures: FailureAttempt[],
): Promise<Map<string, { due_at: Date }>> {
  const questionIds = Array.from(new Set(failures.map((failure) => failure.question_id)));
  if (questionIds.length === 0) return new Map();
  const knowledgeIds = Array.from(
    new Set(failures.flatMap((failure) => failure.referenced_knowledge_ids)),
  );
  const knowledgeRows =
    knowledgeIds.length === 0
      ? []
      : await db
          .select({
            subject_id: material_fsrs_state.subject_id,
            due_at: material_fsrs_state.due_at,
          })
          .from(material_fsrs_state)
          .where(
            and(
              eq(material_fsrs_state.subject_kind, 'knowledge'),
              inArray(material_fsrs_state.subject_id, knowledgeIds),
            ),
          );
  const dueByKnowledgeId = new Map(knowledgeRows.map((r) => [r.subject_id, { due_at: r.due_at }]));

  const legacyQuestionRows = await db
    .select({ subject_id: material_fsrs_state.subject_id, due_at: material_fsrs_state.due_at })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'question'),
        inArray(material_fsrs_state.subject_id, questionIds),
      ),
    );
  const legacyByQuestionId = new Map(
    legacyQuestionRows.map((r) => [r.subject_id, { due_at: r.due_at }]),
  );

  const out = new Map<string, { due_at: Date }>();
  for (const failure of failures) {
    let selected: { due_at: Date } | null = null;
    for (const knowledgeId of failure.referenced_knowledge_ids) {
      const state = dueByKnowledgeId.get(knowledgeId);
      if (!state) continue;
      if (!selected || state.due_at < selected.due_at) selected = state;
    }
    selected = selected ?? legacyByQuestionId.get(failure.question_id) ?? null;
    if (selected) out.set(failure.question_id, selected);
  }
  return out;
}

async function loadVariants(
  db: Db,
  questionIds: string[],
): Promise<Map<string, Array<{ id: string; status: string }>>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: mistake_variant.id,
      parent_question_id: mistake_variant.parent_question_id,
      status: mistake_variant.status,
    })
    .from(mistake_variant)
    .where(inArray(mistake_variant.parent_question_id, questionIds));
  const map = new Map<string, Array<{ id: string; status: string }>>();
  for (const row of rows) {
    const list = map.get(row.parent_question_id) ?? [];
    list.push({ id: row.id, status: row.status });
    map.set(row.parent_question_id, list);
  }
  return map;
}

function aggregatePoints(labels: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 500);
}

function causeLabel(input: {
  cause: { primary_category: string } | null;
  knowledgeIds: readonly string[];
  knowledgeById: ReadonlyMap<string, { name: string; effective_domain: string | null }>;
  miscLabels: ReadonlyMap<string, string>;
}): string {
  if (!input.cause) return '未分类';
  const misc = input.miscLabels.get(input.cause.primary_category);
  if (misc) return misc;
  // Built-in cause ids are per-subject vocabulary; the knowledge domain picks
  // the profile whose label is the learner-facing word for this row.
  for (const knowledgeId of input.knowledgeIds) {
    const domain = input.knowledgeById.get(knowledgeId)?.effective_domain ?? null;
    const label = resolveSubjectProfile(domain).causeCategories.find(
      (category) => category.id === input.cause?.primary_category,
    )?.label;
    if (label) return label;
  }
  return (
    resolveSubjectProfile(null).causeCategories.find(
      (category) => category.id === input.cause?.primary_category,
    )?.label ?? '其他'
  );
}

function buildAggregates(input: {
  final: Array<{
    fa: { referenced_knowledge_ids: string[] };
    cause: { primary_category: string } | null;
  }>;
  knowledgeById: ReadonlyMap<string, { name: string; effective_domain: string | null }>;
  miscLabels: ReadonlyMap<string, string>;
  truncated: boolean;
  includeCause: boolean;
}): {
  counted: number;
  truncated: boolean;
  by_cause?: Array<{ name: string; points: Array<[string, number]> }>;
  by_knowledge: Array<{ name: string; points: Array<[string, number]> }>;
} {
  const counted = input.final.length;
  const byCause = input.includeCause
    ? [
        {
          name: '错次',
          points: aggregatePoints(
            input.final.map((row) =>
              causeLabel({
                cause: row.cause,
                knowledgeIds: row.fa.referenced_knowledge_ids,
                knowledgeById: input.knowledgeById,
                miscLabels: input.miscLabels,
              }),
            ),
          ),
        },
      ]
    : undefined;
  const knowledgeLabels = input.final.flatMap((row) =>
    row.fa.referenced_knowledge_ids.map(
      (knowledgeId) => input.knowledgeById.get(knowledgeId)?.name ?? '未知知识点',
    ),
  );
  return {
    counted,
    truncated: input.truncated,
    ...(byCause ? { by_cause: counted > 0 ? byCause : [] } : {}),
    by_knowledge: counted > 0 ? [{ name: '错次', points: aggregatePoints(knowledgeLabels) }] : [],
  };
}

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const filter = input.filter ?? {};
  // P5.1 / — courtesy default (20) centralized in budgets.ts;
  // byte-unchanged from the prior inline literal.
  const limit = filter.limit ?? TOOL_COURTESY_DEFAULTS.query_mistakes;
  const since = filter.sinceDays ? new Date(Date.now() - filter.sinceDays * 86_400_000) : undefined;

  const hasPostFilter =
    filter.knowledgeId !== undefined ||
    filter.causeCategoryId !== undefined ||
    filter.dueWithinDays !== undefined;
  const candidates = await getFailureAttemptsForDerivation(ctx.db, {
    // +1 detects truncation without an unbounded scan when no post-filter is set.
    limit: hasPostFilter ? null : limit + 1,
    since,
  });

  // Pre-filter by knowledge_id (cheap inline check) before resolving cause.
  const byKnowledge = filter.knowledgeId
    ? candidates.filter((c) => c.referenced_knowledge_ids.includes(filter.knowledgeId as string))
    : candidates;

  // Optionally resolve cause; if the caller asked to filter by causeCategoryId
  // we resolve regardless so the filter can apply.
  const wantsCause = input.includeAttribution !== false || !!filter.causeCategoryId;
  const withCause = byKnowledge.map((fa) => ({
    fa,
    cause: wantsCause ? effectiveCauseForFailureAttempt(fa) : null,
  }));

  const byCause = filter.causeCategoryId
    ? withCause.filter((x) => x.cause?.primary_category === filter.causeCategoryId)
    : withCause;

  // FSRS state lookup + dueWithinDays filter.
  const fsrsMap = await loadFsrsStates(
    ctx.db,
    byCause.map((x) => x.fa),
  );
  const dueCutoff =
    filter.dueWithinDays !== undefined
      ? new Date(Date.now() + filter.dueWithinDays * 86_400_000)
      : null;
  const byDue = dueCutoff
    ? byCause.filter((x) => {
        const state = fsrsMap.get(x.fa.question_id);
        return state ? state.due_at <= dueCutoff : false;
      })
    : byCause;

  // Apply final limit.
  const final = byDue.slice(0, limit);
  const finalQids = Array.from(new Set(final.map((x) => x.fa.question_id)));
  const finalKnowledgeIds = Array.from(
    new Set(final.flatMap((x) => x.fa.referenced_knowledge_ids)),
  );
  // 四个独立读并行（/1020 misc_ primary + secondary id 的 title 回填含在内，
  // 同一批查询）。
  const [promptMap, variantsMap, miscLabels, knowledgeRows] = await Promise.all([
    loadQuestionPrompts(ctx.db, finalQids),
    input.includeVariants
      ? loadVariants(ctx.db, finalQids)
      : Promise.resolve(new Map<string, Array<{ id: string; status: string }>>()),
    resolveMiscCauseLabels(
      ctx.db,
      final.flatMap((x) =>
        x.cause ? [x.cause.primary_category, ...x.cause.secondary_categories] : [],
      ),
    ),
    finalKnowledgeIds.length > 0
      ? loadFailureLearningKnowledgeContext(ctx.db, finalKnowledgeIds)
      : Promise.resolve([] as Awaited<ReturnType<typeof loadFailureLearningKnowledgeContext>>),
  ]);
  const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row]));

  const now = Date.now();
  const mistakes = final.map(({ fa, cause }) => {
    const promptMd = promptMap.get(fa.question_id) ?? '';
    const fsrs = fsrsMap.get(fa.question_id);
    const row: Output['mistakes'][number] = {
      event_id: fa.attempt_event_id,
      question_id: fa.question_id,
      prompt_snippet: promptMd.slice(0, PROMPT_SNIPPET_MAX),
      attempted_at: fa.created_at.toISOString(),
      cause: cause
        ? {
            source: cause.source,
            primary_category: cause.primary_category,
            primary_label: miscLabels.get(cause.primary_category) ?? null,
            secondary_categories: cause.secondary_categories,
            secondary_labels: miscCauseLabelMap(miscLabels, cause.secondary_categories),
            analysis_md: cause.analysis_md,
            user_notes: cause.user_notes,
            confidence: cause.confidence,
          }
        : null,
      review_state: fsrs
        ? {
            due_at: fsrs.due_at.toISOString(),
            is_due: fsrs.due_at.getTime() <= now,
          }
        : null,
      knowledge_ids: fa.referenced_knowledge_ids,
    };
    if (input.includeVariants) {
      row.variants = variantsMap.get(fa.question_id) ?? [];
    }
    return row;
  });

  const aggregates = buildAggregates({
    final,
    knowledgeById,
    miscLabels,
    includeCause: wantsCause,
    // Windowed aggregates: with no post-filter the reader stopped at
    // limit+1 raw rows, so any extra row means the window is partial.
    truncated: hasPostFilter ? byDue.length > limit : candidates.length > limit,
  });
  return OutputSchema.parse({
    mistakes,
    total: mistakes.length,
    filter_applied: {
      cause: filter.causeCategoryId ?? null,
      knowledge: filter.knowledgeId ?? null,
      due_within_days: filter.dueWithinDays ?? null,
      since_days: filter.sinceDays ?? null,
      limit,
    },
    aggregates,
    chart_bindings: wantsCause
      ? ['/aggregates/by_cause', '/aggregates/by_knowledge']
      : ['/aggregates/by_knowledge'],
    // A window is only named when the rows really reach back across all of it.
    chart_caption:
      filter.sinceDays && !aggregates.truncated
        ? `近 ${filter.sinceDays} 天`
        : `本次查询的 ${aggregates.counted} 条`,
    claim_boundaries: {
      zero_rows_scope: 'matching_failure_attempt_rows_only',
      supports_entity_inventory_claim: false,
      supports_lifecycle_status_count_claim: false,
    },
  });
}

function summarize(input: Input, output: Output): string {
  const f = input.filter ?? {};
  const parts: string[] = [`${output.total} rows`];
  const due = output.mistakes.filter((m) => m.review_state?.is_due).length;
  if (due > 0) parts.push(`${due} due`);
  if (f.causeCategoryId) parts.push(`cause=${f.causeCategoryId}`);
  if (f.knowledgeId) parts.push(`k=${f.knowledgeId}`);
  if (f.dueWithinDays !== undefined) parts.push(`due≤${f.dueWithinDays}d`);
  if (f.sinceDays) parts.push(`since≤${f.sinceDays}d`);
  return `mistakes · ${parts.join(' · ')}`;
}

export const queryMistakesTool: DomainTool<Input, Output> = {
  name: 'query_mistakes',
  description: DESCRIPTION,
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize,
  // Lane D mirrorEvent policy: write event when caller is Copilot / Teaching;
  // Dreaming batch calls skip mirror to keep events table clean.
  mirrorEvent: 'when_user_visible',
};
