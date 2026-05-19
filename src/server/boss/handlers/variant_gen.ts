// Phase 2 (Task #17) — async variant question generation.
//
// Triggered after attribution_followup writes a judge event for a failure
// attempt. If the cause's primary_category is in the "worth varying" set
// (concept / knowledge_gap / method / calculation / reading / memory /
// expression), generate one variant question and persist it with
// source='mistake_variant', draft_status='draft', variant_depth=parent+1.
//
// MVP — single pass (no VariantVerifyTask), no UI surface beyond the
// question row, no per-mistake variants_max counter. Counter / verify
// double pass / "再来几道" button are spec'd Phase 3 features.
//
// Defense against "错题繁殖":
//   1. variant_depth >= 2 → skip (spec §3.4.4 cap)
//   2. parent question.source === 'mistake_variant' → skip (variants do not
//      themselves spawn variants — spec §3.4.4 chain termination)
//   3. cause.primary_category ∈ {carelessness, time_pressure, other} → skip
//      (spec §3.4.1 — these don't benefit from variants)

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { QuestionKind } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface VariantGenJobData {
  attempt_event_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

const VariantOutputSchema = z.object({
  prompt_md: z.string().min(1).max(2000),
  reference_md: z.string().min(1).max(2000),
  difficulty: z.number().int().min(1).max(5),
  reasoning: z.string().min(1).max(500),
});

function parseVariantOutput(text: string): z.infer<typeof VariantOutputSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVariantOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseVariantOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return VariantOutputSchema.parse(json);
}

const SKIP_CAUSES: ReadonlySet<string> = new Set([
  'carelessness',
  'time_pressure',
  'other',
]);

export interface RunVariantGenParams {
  db: Db;
  attemptEventId: string;
  runTaskFn: RunTaskFn;
}

export interface RunVariantGenResult {
  status:
    | 'generated'
    | 'skipped:attempt_not_found'
    | 'skipped:not_a_failure_attempt'
    | 'skipped:no_judge_yet'
    | 'skipped:question_not_found'
    | 'skipped:max_depth'
    | 'skipped:variant_chain_terminus'
    | 'skipped:cause_not_targetable'
    | 'skipped:already_has_variant';
  variant_question_id?: string;
}

export async function runVariantGen(params: RunVariantGenParams): Promise<RunVariantGenResult> {
  const { db, attemptEventId, runTaskFn } = params;

  // Load the attempt event
  const attemptRows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, attemptEventId))
    .limit(1);
  const attempt = attemptRows[0];
  if (!attempt) return { status: 'skipped:attempt_not_found' };
  if (
    attempt.action !== 'attempt' ||
    attempt.subject_kind !== 'question' ||
    attempt.outcome !== 'failure'
  ) {
    return { status: 'skipped:not_a_failure_attempt' };
  }

  // Load chained judge event (cause)
  const judgeRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, attemptEventId),
      ),
    )
    .limit(1);
  const judge = judgeRows[0];
  if (!judge) return { status: 'skipped:no_judge_yet' };
  const judgePayload = judge.payload as {
    cause?: { primary_category?: string; analysis_md?: string };
  };
  const cause = judgePayload.cause;
  if (!cause?.primary_category) return { status: 'skipped:cause_not_targetable' };
  if (SKIP_CAUSES.has(cause.primary_category)) {
    return { status: 'skipped:cause_not_targetable' };
  }

  // Load the parent question
  const qRows = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
      variant_depth: question.variant_depth,
      root_question_id: question.root_question_id,
      difficulty: question.difficulty,
    })
    .from(question)
    .where(eq(question.id, attempt.subject_id))
    .limit(1);
  const parent = qRows[0];
  if (!parent) return { status: 'skipped:question_not_found' };
  if (parent.source === 'mistake_variant') {
    return { status: 'skipped:variant_chain_terminus' };
  }
  if (parent.variant_depth >= 1) {
    // depth=0 (原题) → can spawn depth=1; depth=1 cannot spawn depth=2 per
    // spec §3.4.4 ("不超过 2 代" — i.e. only depth 0 and 1 exist, and
    // depth 1 doesn't spawn depth 2).
    return { status: 'skipped:max_depth' };
  }

  // Idempotency: did we already generate a variant for this attempt? Check
  // for an existing question whose parent_variant_id starts the chain at
  // this attempt's parent (best signal we have without per-mistake counter).
  // We use parent_variant_id = parent.id + a marker; simpler check: count
  // existing variants of THIS parent and cap at 1 for MVP (no per-mistake
  // counter; refine later).
  const existingVariants = await db
    .select({ id: question.id })
    .from(question)
    .where(eq(question.parent_variant_id, parent.id))
    .limit(1);
  if (existingVariants.length > 0) {
    return { status: 'skipped:already_has_variant' };
  }

  const payload = attempt.payload as { answer_md?: string | null };
  const firstKnowledgeId = parent.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];

  const input = {
    original_question: {
      id: parent.id,
      kind: parent.kind,
      prompt_md: parent.prompt_md,
      reference_md: parent.reference_md,
      knowledge_ids: parent.knowledge_ids,
    },
    attempt: { wrong_answer_md: payload.answer_md ?? '' },
    cause: {
      primary_category: cause.primary_category,
      analysis_md: cause.analysis_md ?? '',
    },
    depth: parent.variant_depth,
  };

  const result = await runTaskFn('VariantGenTask', input, {
    db,
    subjectProfile: resolveSubjectProfile(knowledgeRows[0]?.domain),
  });
  const parsed = parseVariantOutput(result.text);

  // Persist new variant question
  const variantId = createId();
  const now = new Date();
  const rootId = parent.root_question_id ?? parent.id;

  // Validate parent.kind is a known QuestionKind (Zod-coerce)
  const kindParsed = QuestionKind.safeParse(parent.kind);
  const kind = kindParsed.success ? kindParsed.data : 'short_answer';

  await db.insert(question).values({
    id: variantId,
    kind,
    prompt_md: parsed.prompt_md,
    reference_md: parsed.reference_md,
    knowledge_ids: parent.knowledge_ids,
    difficulty: parsed.difficulty,
    source: 'mistake_variant',
    source_ref: attemptEventId,
    draft_status: 'draft',
    variant_depth: parent.variant_depth + 1,
    root_question_id: rootId,
    parent_variant_id: parent.id,
    created_by: {
      by: 'ai',
      task_kind: 'VariantGenTask',
    } as never,
    metadata: { reasoning: parsed.reasoning, source_attempt: attemptEventId } as never,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { status: 'generated', variant_question_id: variantId };
}

export function buildVariantGenHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<VariantGenJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const attemptEventId = job.data?.attempt_event_id;
      if (!attemptEventId) {
        console.warn('[variant_gen] job missing attempt_event_id', job.id);
        continue;
      }
      try {
        const result = await runVariantGen({ db, attemptEventId, runTaskFn });
        console.log(`[variant_gen] ${attemptEventId} → ${result.status}`);
      } catch (err) {
        console.error(`[variant_gen] ${attemptEventId} failed`, err);
        throw err;
      }
    }
  };
}
