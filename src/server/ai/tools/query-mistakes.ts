// YUK-80 / Foundation D M1 Lane B
//
// `query_mistakes` — the first DomainTool implementation. Returns a
// summarised view of recent failure attempts with optional cause /
// review-state / variant joins. Designed for Copilot drawer + Dreaming
// to ask "what's the user struggling with right now?" without scanning
// raw event rows.

import type { Db } from '@/db/client';
import { material_fsrs_state, mistake_variant, question } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttempts } from '@/server/events/queries';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
// P5.1 / YUK-143 — snippet cap + courtesy default sourced from budgets.ts.
// Both are byte-unchanged from the prior file-local literals (160 / 20).
import { MISTAKE_PROMPT_SNIPPET_MAX, TOOL_COURTESY_DEFAULTS } from './budgets';
import type { DomainTool, ToolContext } from './types';

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

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const filter = input.filter ?? {};
  // P5.1 / YUK-143 — courtesy default (20) centralized in budgets.ts;
  // byte-unchanged from the prior inline literal.
  const limit = filter.limit ?? TOOL_COURTESY_DEFAULTS.query_mistakes;
  const since = filter.sinceDays ? new Date(Date.now() - filter.sinceDays * 86_400_000) : undefined;

  const hasPostFilter =
    filter.knowledgeId !== undefined ||
    filter.causeCategoryId !== undefined ||
    filter.dueWithinDays !== undefined;
  const candidates = await getFailureAttempts(ctx.db, {
    limit: hasPostFilter ? null : limit,
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
  const promptMap = await loadQuestionPrompts(ctx.db, finalQids);
  const variantsMap = input.includeVariants
    ? await loadVariants(ctx.db, finalQids)
    : new Map<string, Array<{ id: string; status: string }>>();

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
