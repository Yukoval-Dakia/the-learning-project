import { z } from 'zod';
import { createAsk, readAskState } from '../agent/asks';
import {
  INGESTION_AGENT_ITEM_PREVIEW_MAX,
  IngestionAgentErrorCode,
  type IngestionAgentErrorCodeT,
  IngestionAgentItemStatus,
  IngestionAgentStage,
  IngestionAskOption,
} from '../agent/contract';
import { readLatestItemStatus, readTerminalRequest } from '../agent/ledger';
import {
  writeAgentErrorEvent,
  writeAgentItemEvent,
  writeAgentItemState,
  writeAgentStageEvent,
  writeAgentTerminalRequest,
} from '../events/agent-progress';
import { redactIngestionText } from '../privacy-guard';
import { recordAgentRedaction } from './redaction-sink';
import { requireIngestionScope } from './source-tool-support';
import type { DomainTool, ToolContext } from './types';

// The two agent-only contract tools.
//
// report_ingestion_progress writes the SSE stage/item/error events; item reports
// also persist an internal state row so a later segment can resume mid-item.
// preview text is redacted and truncated so raw personal text never reaches events.
//
//   ask_learner — creates a durable ask (ask.created + ingestion_agent.ask in
//     one tx) or polls one. The tool NEVER blocks: create returns the ask_id
//     and the agent either keeps working on other items or ends its turn; the
//     answer/timeout lane resolves the ask and enqueues the next segment.

// ---------- redaction accounting (feeds the per-run usage receipt) ----------

// The sink itself lives in ./redaction-sink.ts so every text-bearing tool
// (read_source, glm_ocr, these two) reports into the same run scope.

const StageReportInput = z.object({
  event: z.literal('stage'),
  stage: IngestionAgentStage,
  pages: z.object({ total: z.number().int().min(0), done: z.number().int().min(0) }).optional(),
  /** Contract keys exactly: {items_total, items_done, items_withheld, items_failed}. */
  counts: z
    .object({
      items_total: z.number().int().min(0),
      items_done: z.number().int().min(0),
      items_withheld: z.number().int().min(0),
      items_failed: z.number().int().min(0),
    })
    .optional(),
});

const ItemReportInput = z.object({
  event: z.literal('item'),
  item_id: z.string().min(1).max(120),
  question_no: z.string().min(1).max(40),
  status: IngestionAgentItemStatus,
  reason: z.string().max(500).optional(),
  /** 0-based source page index (same numbering as the read_source manifest);
   * the server emits the contract's 1-based `page`. */
  page_index: z.number().int().min(0).optional(),
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

// pi mount 编译只接受 z.object 顶层（buildPiDomainAgentTools 拒绝 union root）；
// 声明面对模型放开为并集对象，严格判别仍由 execute 内的 union parse 承担。
const ReportProgressToolInput = z.object({
  event: z.enum(['stage', 'item', 'error']),
  stage: IngestionAgentStage.optional(),
  pages: z.object({ total: z.number().int().min(0), done: z.number().int().min(0) }).optional(),
  counts: z
    .object({
      items_total: z.number().int().min(0),
      items_done: z.number().int().min(0),
      items_withheld: z.number().int().min(0),
      items_failed: z.number().int().min(0),
    })
    .optional(),
  item_id: z.string().min(1).max(120).optional(),
  question_no: z.string().min(1).max(40).optional(),
  status: IngestionAgentItemStatus.optional(),
  reason: z.string().max(500).optional(),
  page_index: z.number().int().min(0).optional(),
  preview_text: z.string().max(400).optional(),
  draft_ref: z.string().optional(),
  question_id: z.string().optional(),
  scope: z.enum(['session', 'item']).optional(),
  code: IngestionAgentErrorCode.optional(),
  retryable: z.boolean().optional(),
});
type ReportProgressToolInputT = z.infer<typeof ReportProgressToolInput>;

const ReportProgressOutputSchema = z.object({
  emitted: z.string(),
  item_status_recorded: z.boolean().optional(),
});
type ReportProgressOutput = z.infer<typeof ReportProgressOutputSchema>;

function previewMarkdown(ctx: ToolContext, previewText: string | undefined): string | undefined {
  if (previewText == null) return undefined;
  const redacted = redactIngestionText(previewText);
  recordAgentRedaction(ctx, redacted);
  const compact = redacted.text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  return compact.slice(0, INGESTION_AGENT_ITEM_PREVIEW_MAX);
}

async function executeReportProgress(
  ctx: ToolContext,
  raw: ReportProgressToolInputT,
): Promise<ReportProgressOutput> {
  const input = ReportProgressInputSchema.parse(raw);
  const sessionId = requireIngestionScope(ctx);
  // R2-6: once a terminal request exists, no further progress may coexist
  // with the session error the orchestrator is about to emit.
  if (input.event !== 'error' || input.scope !== 'session') {
    const requested = await readTerminalRequest(ctx.db, sessionId);
    if (requested != null) {
      return { emitted: `terminal_request(${requested.code})` };
    }
  }
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
          ...(input.page_index != null ? { page: input.page_index + 1 } : {}),
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
      // R2-6: the model may only emit item-scope errors. A session-scope
      // report (e.g. page_unreadable for the whole package) is recorded as a
      // terminal request; the ORCHESTRATOR emits the session error and fails
      // the run — a model can never mint the session error itself.
      if (input.scope === 'session') {
        await writeAgentTerminalRequest(ctx.db, sessionId, {
          code: input.code as IngestionAgentErrorCodeT,
        });
        return {
          emitted: `terminal_request(${input.code}) — the run will now end; do not emit further progress`,
        };
      }
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

export const reportIngestionProgressTool: DomainTool<
  ReportProgressToolInputT,
  ReportProgressOutput
> = {
  name: 'report_ingestion_progress',
  description:
    'Emit a durable R8 progress event for this ingestion run: event=stage {stage, pages?, counts?{items_total,items_done,items_withheld,items_failed}}, event=item {item_id, question_no, status(queued|structuring|solving|calibrating|admitted|withheld|failed), reason?, page_index? (0-based manifest index — the server emits it 1-based), preview_text?, draft_ref?, question_id?}, or event=error {scope, item_id?, code(page_unreadable|solve_timeout|model_unavailable|budget_exhausted|crop_failed|worker_lost|structure_failed|ask_expired|policy_blocked), retryable}. scope=item reports a per-item failure; scope=session does NOT emit the error — it records a terminal request so the run ends cleanly (the orchestrator owns the session error). preview_text is redacted and truncated to 80 chars by the server — never put raw student handwriting or identifiers in it. Call once per transition; every call is a durable job_events row the UI sees immediately.',
  effect: 'write',
  inputSchema: ReportProgressToolInput,
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

// pi mount 编译只接受 z.object 顶层（同 report_ingestion_progress）；ask_id
// presence 区分 poll/create 的判别由 execute 内的 union parse 承担。
const AskLearnerToolInput = z.object({
  ask_id: z.string().min(1).optional(),
  item_id: z.string().min(1).max(120).optional(),
  question_no: z.string().min(1).max(40).optional(),
  prompt_md: z.string().min(1).max(2000).optional(),
  answer_kind: z.enum(['choice', 'short']).optional(),
  options: z.array(IngestionAskOption).min(2).max(12).optional(),
  placeholder: z.string().max(200).optional(),
  expires_in_seconds: z.number().int().min(30).max(86_400).nullable().optional(),
  context_md: z.string().max(1000).optional(),
});
type AskLearnerToolInputT = z.infer<typeof AskLearnerToolInput>;

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

/** Redact the free-text part of a resolved answer before it enters the model. */
function redactAskAnswer(ctx: ToolContext, answer: unknown): unknown {
  if (
    answer == null ||
    typeof answer !== 'object' ||
    (answer as { kind?: string }).kind !== 'text' ||
    typeof (answer as { text?: unknown }).text !== 'string'
  ) {
    return answer;
  }
  const redacted = redactIngestionText((answer as { text: string }).text);
  recordAgentRedaction(ctx, redacted);
  return { ...(answer as Record<string, unknown>), text: redacted.text };
}

async function executeAskLearner(
  ctx: ToolContext,
  raw: AskLearnerToolInputT,
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
    // R2-2: learner answer text is external input to the model — redact it
    // like every other text channel (counts fold into the run's sink).
    return {
      status: 'resolved',
      ask_id: input.ask_id,
      answer: redactAskAnswer(ctx, state.resolved.answer),
    };
  }

  if (input.answer_kind === 'choice' && (input.options == null || input.options.length < 2)) {
    throw new Error('ask_learner: answer_kind choice requires at least two options');
  }
  // Learner-facing ask text goes through the same redaction as previews —
  // quoted source text can carry identifiers the page held.
  const promptRedacted = redactIngestionText(input.prompt_md);
  recordAgentRedaction(ctx, promptRedacted);
  const options = input.options?.map((option) => {
    const label = redactIngestionText(option.label_md);
    recordAgentRedaction(ctx, label);
    return { id: option.id, label_md: label.text };
  });
  // Contract requires `placeholder`; fill a kind-appropriate default when the
  // model omits it.
  const placeholderRaw =
    input.placeholder ?? (input.answer_kind === 'choice' ? '请选择一项' : '请简要输入你的答案');
  const placeholderRedacted = redactIngestionText(placeholderRaw);
  recordAgentRedaction(ctx, placeholderRedacted);
  const contextMd =
    input.context_md != null
      ? (() => {
          const out = redactIngestionText(input.context_md as string);
          recordAgentRedaction(ctx, out);
          return out.text;
        })()
      : undefined;
  // Atomic create-or-adopt: a re-segmented/replayed run asking about the same
  // item returns the still-open ask instead of minting a duplicate.
  const created = await createAsk(ctx.db, {
    sessionId,
    item_id: input.item_id,
    question_no: input.question_no,
    prompt_md: promptRedacted.text,
    answer_kind: input.answer_kind,
    ...(options != null ? { options } : {}),
    placeholder: placeholderRedacted.text,
    expires_in_seconds:
      input.expires_in_seconds === undefined
        ? DEFAULT_ASK_EXPIRES_SECONDS
        : input.expires_in_seconds,
    ...(contextMd != null ? { context_md: contextMd } : {}),
  });
  return { status: 'pending', ask_id: created.ask_id, expires_at: created.expires_at };
}

export const askLearnerTool: DomainTool<AskLearnerToolInputT, AskLearnerOutput> = {
  name: 'ask_learner',
  description:
    'Ask the learner a question you cannot decide yourself, or poll an existing ask. Create: {item_id, question_no, prompt_md, answer_kind(choice|short), options?[{id,label_md}] (required for choice), placeholder?, expires_in_seconds? (default 1800; null = wait forever), context_md?} → {status:pending, ask_id}. The ask is durable and the learner answers asynchronously — DO NOT stop working: continue with other items, then either poll {ask_id} → {status:pending|resolved,answer} or end your turn (the run resumes automatically when the answer or a timeout lands). Poll: {ask_id}.',
  effect: 'write',
  inputSchema: AskLearnerToolInput,
  outputSchema: AskLearnerOutputSchema,
  costClass: 'local',
  execute: executeAskLearner,
  summarize: (_input, output) =>
    `ask_learner ${output.status}${output.status === 'pending' ? ` ask=${output.ask_id}` : ''}`,
  mirrorEvent: 'never',
};
