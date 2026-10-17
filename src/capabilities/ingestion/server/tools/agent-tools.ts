import { z } from 'zod';
import { createAsk, findOpenAskForItem, readAskState } from '../agent/asks';
import {
  INGESTION_AGENT_ITEM_PREVIEW_MAX,
  IngestionAgentErrorCode,
  IngestionAgentItemStatus,
  IngestionAgentStage,
  IngestionAskOption,
} from '../agent/contract';
import { readLatestItemStatus } from '../agent/ledger';
import {
  writeAgentErrorEvent,
  writeAgentItemEvent,
  writeAgentItemState,
  writeAgentStageEvent,
} from '../events/agent-progress';
import { type IngestionRedactionField, redactIngestionText } from '../privacy-guard';
import { requireIngestionScope } from './source-tool-support';
import type { DomainTool, ToolContext } from './types';

// YUK-1522 (R8) — the two agent-only tools that make the R8 contract durable:
//
//   report_ingestion_progress — writes ingestion_agent.stage / .item / .error
//     job_events rows (the SSE contract). Item reports also land an internal
//     agent.item_state row carrying draft_ref/question_id so a later run
//     segment can resume mid-item. preview_text is re-redacted through
//     redactIngestionText and hard-truncated to 80 chars before it becomes
//     preview_md — raw or personal text can never reach the event payload.
//
//   ask_learner — creates a durable ask (ask.created + ingestion_agent.ask in
//     one tx) or polls one. The tool NEVER blocks: create returns the ask_id
//     and the agent either keeps working on other items or ends its turn; the
//     answer/timeout lane resolves the ask and enqueues the next segment.

// ---------- redaction accounting (feeds the per-run usage receipt) ----------

export interface AgentRedactionSink {
  readonly fields: Set<IngestionRedactionField>;
  readonly counts: Partial<Record<IngestionRedactionField, number>>;
}

const redactionSinks = new WeakMap<ToolContext, AgentRedactionSink>();

/** Run-scoped accumulator: the orchestrator attaches one sink per segment. */
export function attachAgentRedactionSink(ctx: ToolContext): AgentRedactionSink {
  const sink: AgentRedactionSink = { fields: new Set(), counts: {} };
  redactionSinks.set(ctx, sink);
  return sink;
}

function recordRedaction(
  ctx: ToolContext,
  result: {
    fields: IngestionRedactionField[];
    counts: Partial<Record<IngestionRedactionField, number>>;
  },
): void {
  const sink = redactionSinks.get(ctx);
  if (sink == null) return;
  for (const field of result.fields) {
    sink.fields.add(field);
    const count = result.counts[field];
    if (count != null) sink.counts[field] = (sink.counts[field] ?? 0) + count;
  }
}

const StageReportInput = z.object({
  event: z.literal('stage'),
  stage: IngestionAgentStage,
  pages: z.object({ total: z.number().int().min(0), done: z.number().int().min(0) }).optional(),
  counts: z
    .object({
      segmented: z.number().int().min(0).optional(),
      structured: z.number().int().min(0).optional(),
      admitted: z.number().int().min(0).optional(),
      withheld: z.number().int().min(0).optional(),
      failed: z.number().int().min(0).optional(),
      pending_ask: z.number().int().min(0).optional(),
    })
    .optional(),
});

const ItemReportInput = z.object({
  event: z.literal('item'),
  item_id: z.string().min(1).max(120),
  question_no: z.string().min(1).max(40),
  status: IngestionAgentItemStatus,
  reason: z.string().max(500).optional(),
  page: z.number().int().min(0).optional(),
  /** Excerpt shown to the learner — re-redacted + truncated server-side. */
  preview_text: z.string().max(400).optional(),
  /** Bookkeeping link (not emitted on the UI contract). */
  draft_ref: z.string().optional(),
  question_id: z.string().optional(),
});

const ErrorReportInput = z.object({
  event: z.literal('error'),
  scope: z.enum(['session', 'item']),
  item_id: z.string().min(1).max(120).optional(),
  code: IngestionAgentErrorCode,
  retryable: z.boolean(),
});

const ReportProgressInputSchema = z.discriminatedUnion('event', [
  StageReportInput,
  ItemReportInput,
  ErrorReportInput,
]);
type ReportProgressInput = z.infer<typeof ReportProgressInputSchema>;

const ReportProgressOutputSchema = z.object({
  emitted: z.string(),
  item_status_recorded: z.boolean().optional(),
});
type ReportProgressOutput = z.infer<typeof ReportProgressOutputSchema>;

function previewMarkdown(ctx: ToolContext, previewText: string | undefined): string | undefined {
  if (previewText == null) return undefined;
  const redacted = redactIngestionText(previewText);
  recordRedaction(ctx, { fields: redacted.fields, counts: redacted.counts });
  const compact = redacted.text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  return compact.slice(0, INGESTION_AGENT_ITEM_PREVIEW_MAX);
}

async function executeReportProgress(
  ctx: ToolContext,
  raw: ReportProgressInput,
): Promise<ReportProgressOutput> {
  const input = ReportProgressInputSchema.parse(raw);
  const sessionId = requireIngestionScope(ctx);
  switch (input.event) {
    case 'stage': {
      const eventId = await writeAgentStageEvent(ctx.db, sessionId, {
        kind: 'ingestion_agent.stage',
        stage: input.stage,
        ...(input.pages != null ? { pages: input.pages } : {}),
        ...(input.counts != null ? { counts: input.counts } : {}),
      });
      return { emitted: `ingestion_agent.stage#${eventId}` };
    }
    case 'item': {
      // Retry/segment dedupe: the same status reported twice must not stack a
      // second progress frame (retried segments replay the same tool calls).
      const latest = await readLatestItemStatus(ctx.db, sessionId, input.item_id);
      const previewMd = previewMarkdown(ctx, input.preview_text);
      let eventId: number | 'deduplicated' = 'deduplicated';
      if (latest !== input.status) {
        eventId = await writeAgentItemEvent(ctx.db, sessionId, {
          kind: 'ingestion_agent.item',
          item_id: input.item_id,
          question_no: input.question_no,
          status: input.status,
          ...(input.reason != null ? { reason: input.reason } : {}),
          ...(input.page != null ? { page: input.page } : {}),
          ...(previewMd != null ? { preview_md: previewMd } : {}),
        });
      }
      // Internal ledger — keeps draft/question linkage for resume without
      // widening the UI contract payload.
      if (input.draft_ref != null || input.question_id != null) {
        await writeAgentItemState(ctx.db, sessionId, {
          item_id: input.item_id,
          question_no: input.question_no,
          status: input.status,
          ...(input.draft_ref != null ? { draft_ref: input.draft_ref } : {}),
          ...(input.question_id != null ? { question_id: input.question_id } : {}),
        });
      }
      return { emitted: `ingestion_agent.item#${eventId}` };
    }
    case 'error': {
      const eventId = await writeAgentErrorEvent(ctx.db, sessionId, {
        kind: 'ingestion_agent.error',
        scope: input.scope,
        ...(input.item_id != null ? { item_id: input.item_id } : {}),
        code: input.code,
        retryable: input.retryable,
      });
      return { emitted: `ingestion_agent.error#${eventId}` };
    }
  }
}

export const reportIngestionProgressTool: DomainTool<ReportProgressInput, ReportProgressOutput> = {
  name: 'report_ingestion_progress',
  description:
    'Emit a durable R8 progress event for this ingestion run: event=stage {stage, pages?, counts?}, event=item {item_id, question_no, status(queued|structuring|solving|calibrating|admitted|withheld|failed), reason?, page?, preview_text?, draft_ref?, question_id?}, or event=error {scope(session|item), item_id?, code(page_unreadable|solve_timeout|model_unavailable|budget_exhausted|crop_failed|worker_lost|structure_failed|ask_expired), retryable}. preview_text is redacted and truncated to 80 chars by the server — never put raw student handwriting or identifiers in it. Call once per transition; every call is a durable job_events row the UI sees immediately.',
  effect: 'write',
  inputSchema: ReportProgressInputSchema,
  outputSchema: ReportProgressOutputSchema,
  costClass: 'local',
  execute: executeReportProgress,
  summarize: (_input, output) => `progress ${output.emitted}`,
  mirrorEvent: 'never',
};

// ---------- ask_learner ----------

const AskLearnerInputSchema = z.union([
  z.object({
    ask_id: z.string().min(1),
  }),
  z.object({
    item_id: z.string().min(1).max(120),
    question_no: z.string().min(1).max(40),
    prompt_md: z.string().min(1).max(2000),
    answer_kind: z.enum(['choice', 'short']),
    options: z.array(IngestionAskOption).min(2).max(12).optional(),
    placeholder: z.string().max(200).optional(),
    /** Seconds until the system resolves the ask as skipped-by-timeout; null = wait forever. */
    expires_in_seconds: z.number().int().min(30).max(86_400).nullable().optional(),
    /** Server-side resume bookkeeping — what was blocking the item. */
    context_md: z.string().max(1000).optional(),
  }),
]);
type AskLearnerInput = z.infer<typeof AskLearnerInputSchema>;

const AskLearnerOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    ask_id: z.string(),
    expires_at: z.string().nullable(),
  }),
  z.object({
    status: z.literal('resolved'),
    ask_id: z.string(),
    answer: z.unknown(),
  }),
  z.object({
    status: z.literal('not_found'),
    ask_id: z.string(),
  }),
]);
type AskLearnerOutput = z.infer<typeof AskLearnerOutputSchema>;

const DEFAULT_ASK_EXPIRES_SECONDS = 1_800;

async function executeAskLearner(
  ctx: ToolContext,
  raw: AskLearnerInput,
): Promise<AskLearnerOutput> {
  const input = AskLearnerInputSchema.parse(raw);
  const sessionId = requireIngestionScope(ctx);

  if ('ask_id' in input) {
    const state = await readAskState(ctx.db, input.ask_id);
    if (state == null || state.created.session_id !== sessionId) {
      return { status: 'not_found', ask_id: input.ask_id };
    }
    if (state.resolved == null) {
      return { status: 'pending', ask_id: input.ask_id, expires_at: state.created.expires_at };
    }
    return { status: 'resolved', ask_id: input.ask_id, answer: state.resolved.answer };
  }

  if (input.answer_kind === 'choice' && (input.options == null || input.options.length < 2)) {
    throw new Error('ask_learner: answer_kind choice requires at least two options');
  }
  // Idempotent create: a re-segmented/replayed run asking about the same item
  // returns the still-open ask instead of minting a duplicate.
  const existing = await findOpenAskForItem(ctx.db, sessionId, input.item_id);
  if (existing != null) {
    return { status: 'pending', ask_id: existing.ask_id, expires_at: existing.expires_at };
  }
  // Learner-facing ask text goes through the same redaction as previews —
  // quoted source text can carry identifiers the page held.
  const promptRedacted = redactIngestionText(input.prompt_md);
  recordRedaction(ctx, { fields: promptRedacted.fields, counts: promptRedacted.counts });
  const options = input.options?.map((option) => {
    const label = redactIngestionText(option.label_md);
    recordRedaction(ctx, { fields: label.fields, counts: label.counts });
    return { id: option.id, label_md: label.text };
  });
  const placeholder =
    input.placeholder != null
      ? (() => {
          const out = redactIngestionText(input.placeholder as string);
          recordRedaction(ctx, { fields: out.fields, counts: out.counts });
          return out.text;
        })()
      : undefined;
  const contextMd =
    input.context_md != null
      ? (() => {
          const out = redactIngestionText(input.context_md as string);
          recordRedaction(ctx, { fields: out.fields, counts: out.counts });
          return out.text;
        })()
      : undefined;
  const created = await createAsk(ctx.db, {
    sessionId,
    item_id: input.item_id,
    question_no: input.question_no,
    prompt_md: promptRedacted.text,
    answer_kind: input.answer_kind,
    ...(options != null ? { options } : {}),
    ...(placeholder != null ? { placeholder } : {}),
    expires_in_seconds:
      input.expires_in_seconds === undefined
        ? DEFAULT_ASK_EXPIRES_SECONDS
        : input.expires_in_seconds,
    ...(contextMd != null ? { context_md: contextMd } : {}),
  });
  return { status: 'pending', ask_id: created.ask_id, expires_at: created.expires_at };
}

export const askLearnerTool: DomainTool<AskLearnerInput, AskLearnerOutput> = {
  name: 'ask_learner',
  description:
    'Ask the learner a question you cannot decide yourself, or poll an existing ask. Create: {item_id, question_no, prompt_md, answer_kind(choice|short), options?[{id,label_md}] (required for choice), placeholder?, expires_in_seconds? (default 1800; null = wait forever), context_md?} → {status:pending, ask_id}. The ask is durable and the learner answers asynchronously — DO NOT stop working: continue with other items, then either poll {ask_id} → {status:pending|resolved,answer} or end your turn (the run resumes automatically when the answer or a timeout lands). Poll: {ask_id}.',
  effect: 'write',
  inputSchema: AskLearnerInputSchema,
  outputSchema: AskLearnerOutputSchema,
  costClass: 'local',
  execute: executeAskLearner,
  summarize: (_input, output) =>
    `ask_learner ${output.status}${output.status === 'pending' ? ` ask=${output.ask_id}` : ''}`,
  mirrorEvent: 'never',
};
