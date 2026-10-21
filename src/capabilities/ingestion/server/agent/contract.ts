import { z } from 'zod';

// Ingestion-agent durable event and ask contracts.
//
// Field names and enums are the binding wire shape. Every ingestion_agent payload
// carries `kind` equal to its event_type so SSE replay is self-describing. This
// file is pure schema/constants and must not import @/server/*; writers live in
// events/agent-progress.ts and asks.ts.

export const INGESTION_AGENT_STAGE = 'ingestion_agent.stage' as const;
export const INGESTION_AGENT_ITEM = 'ingestion_agent.item' as const;
export const INGESTION_AGENT_ERROR = 'ingestion_agent.error' as const;
export const INGESTION_AGENT_ASK = 'ingestion_agent.ask' as const;
export const INGESTION_AGENT_ASK_RESOLVED = 'ingestion_agent.ask_resolved' as const;

/** job_events.business_table for durable ask rows (session stream stays clean). */
export const INGESTION_ASK_TABLE = 'ingestion_ask' as const;
/** job_events.business_table for internal run bookkeeping (not a UI contract). */
export const INGESTION_AGENT_RUN_TABLE = 'ingestion_agent_run' as const;

// ---------- stage ----------

export const IngestionAgentStage = z.enum([
  'reading',
  'segmenting',
  'structuring',
  'solving',
  'calibrating',
  'presenting',
  'done',
]);
export type IngestionAgentStageT = z.infer<typeof IngestionAgentStage>;

/**
 * Contract keys, exactly: {items_total, items_done, items_withheld,
 * items_failed}. No other keys; when `counts` is present all four are.
 */
export const IngestionAgentStageCounts = z
  .object({
    items_total: z.number().int().min(0),
    items_done: z.number().int().min(0),
    items_withheld: z.number().int().min(0),
    items_failed: z.number().int().min(0),
  })
  .strict();
export type IngestionAgentStageCountsT = z.infer<typeof IngestionAgentStageCounts>;

export const IngestionAgentStagePayload = z
  .object({
    kind: z.literal(INGESTION_AGENT_STAGE),
    stage: IngestionAgentStage,
    pages: z
      .object({ total: z.number().int().min(0), done: z.number().int().min(0) })
      .strict()
      .optional(),
    counts: IngestionAgentStageCounts.optional(),
  })
  .strict();
export type IngestionAgentStagePayloadT = z.infer<typeof IngestionAgentStagePayload>;

// ---------- item ----------

export const IngestionAgentItemStatus = z.enum([
  'queued',
  'structuring',
  'solving',
  'calibrating',
  'admitted',
  'withheld',
  'failed',
]);
export type IngestionAgentItemStatusT = z.infer<typeof IngestionAgentItemStatus>;

export const IngestionAgentItemPayload = z
  .object({
    kind: z.literal(INGESTION_AGENT_ITEM),
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    status: IngestionAgentItemStatus,
    reason: z.string().optional(),
    /** 1-based source page (contract); the tool accepts the 0-based manifest index and adds 1. */
    page: z.number().int().min(1).optional(),
    /** Redacted, ≤80 chars — enforced by the emitter, not only this schema. */
    preview_md: z.string().max(80).optional(),
  })
  .strict();
export type IngestionAgentItemPayloadT = z.infer<typeof IngestionAgentItemPayload>;

export const INGESTION_AGENT_ITEM_PREVIEW_MAX = 80;

// ---------- error ----------

export const IngestionAgentErrorCode = z.enum([
  'page_unreadable',
  'solve_timeout',
  'model_unavailable',
  'budget_exhausted',
  'crop_failed',
  'worker_lost',
  'structure_failed',
  'ask_expired',
  // R2-8: session refused because the document's derivation policy forbids
  // the paid agent lane (answer_only / crisis).
  'policy_blocked',
]);
export type IngestionAgentErrorCodeT = z.infer<typeof IngestionAgentErrorCode>;

export const IngestionAgentErrorPayload = z
  .object({
    kind: z.literal(INGESTION_AGENT_ERROR),
    scope: z.enum(['session', 'item']),
    item_id: z.string().min(1).optional(),
    code: IngestionAgentErrorCode,
    retryable: z.boolean(),
  })
  .strict();
export type IngestionAgentErrorPayloadT = z.infer<typeof IngestionAgentErrorPayload>;

// ---------- ask / ask_resolved ----------

export const IngestionAskAnswerKind = z.enum(['choice', 'short']);
export type IngestionAskAnswerKindT = z.infer<typeof IngestionAskAnswerKind>;

export const IngestionAskOption = z
  .object({
    id: z.string().min(1),
    label_md: z.string().min(1),
  })
  .strict();
export type IngestionAskOptionT = z.infer<typeof IngestionAskOption>;

export const INGESTION_ASK_ANSWER_TEXT_MAX = 500;

/** 终端答案 union —— 与 ask_resolved payload 及答案 POST body 共用。 */
export const IngestionAskAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), option_id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z.string(),
      via_option: z.literal('none_of_these').optional(),
    })
    .strict(),
  z.object({ kind: z.literal('skipped'), by: z.enum(['learner', 'timeout']) }).strict(),
]);
export type IngestionAskAnswerT = z.infer<typeof IngestionAskAnswer>;

/** POST body 允许的形态：timeout 只能由系统写入。 */
export const IngestionAskAnswerPost = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), option_id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z.string(),
      via_option: z.literal('none_of_these').optional(),
    })
    .strict(),
  z.object({ kind: z.literal('skipped'), by: z.literal('learner') }).strict(),
]);
export type IngestionAskAnswerPostT = z.infer<typeof IngestionAskAnswerPost>;

export const IngestionAgentAskPayload = z
  .object({
    kind: z.literal(INGESTION_AGENT_ASK),
    ask_id: z.string().min(1),
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    prompt_md: z.string().min(1),
    answer_kind: IngestionAskAnswerKind,
    options: z.array(IngestionAskOption).optional(),
    /** Required by the contract — the server fills a kind-appropriate default. */
    placeholder: z.string(),
    /** ISO-8601 or null (wait forever). */
    expires_at: z.string().datetime().nullable(),
  })
  .strict();
export type IngestionAgentAskPayloadT = z.infer<typeof IngestionAgentAskPayload>;

export const IngestionAgentAskResolvedPayload = z
  .object({
    kind: z.literal(INGESTION_AGENT_ASK_RESOLVED),
    ask_id: z.string().min(1),
    answer: IngestionAskAnswer,
  })
  .strict();
export type IngestionAgentAskResolvedPayloadT = z.infer<typeof IngestionAgentAskResolvedPayload>;

// ---------- durable ask rows (job_events business_table='ingestion_ask') ----------

export const ASK_CREATED = 'ask.created' as const;
export const ASK_ANSWER_CLAIMED = 'ask.answer_claimed' as const;
export const ASK_RESOLVED = 'ask.resolved' as const;

export const AskCreatedPayload = z
  .object({
    session_id: z.string().min(1),
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    prompt_md: z.string().min(1),
    answer_kind: IngestionAskAnswerKind,
    options: z.array(IngestionAskOption).optional(),
    /** Required by the contract — defaulted at create when the model omits it. */
    placeholder: z.string(),
    expires_at: z.string().datetime().nullable(),
    /** Resume bookkeeping for the next run segment; never reaches the UI ask payload. */
    context_md: z.string().optional(),
  })
  .strict();
export type AskCreatedPayloadT = z.infer<typeof AskCreatedPayload>;

export const AskAnswerClaimedPayload = z
  .object({
    idempotency_key: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict();

export const AskResolvedPayload = z
  .object({
    answer: IngestionAskAnswer,
    via: z.enum(['answer', 'timeout']),
  })
  .strict();
export type AskResolvedPayloadT = z.infer<typeof AskResolvedPayload>;

// ---------- internal run ledger (business_table='ingestion_agent_run') ----------

export const AGENT_ITEM_STATE = 'agent.item_state' as const;
export const AGENT_RUN_SEGMENT = 'agent.run_segment' as const;

/** Internal item bookkeeping row — carries draft/question linkage the UI contract omits. */
export const AgentItemStatePayload = z
  .object({
    item_id: z.string().min(1),
    question_no: z.string().min(1),
    status: IngestionAgentItemStatus,
    draft_ref: z.string().optional(),
    question_id: z.string().optional(),
  })
  .strict();
export type AgentItemStatePayloadT = z.infer<typeof AgentItemStatePayload>;

export const AgentRunSegmentPayload = z
  .object({
    /** ≥1 = physical run segment; 0 = out-of-band marker (resume_requested/continue_requested). */
    segment: z.number().int().min(0),
    trigger: z.enum(['start', 'resume', 'continue']),
    task_run_id: z.string().optional(),
    open_asks: z.array(z.string()).optional(),
    outcome: z
      .enum([
        'running',
        'waiting',
        'done',
        'failed',
        'early_exit',
        'resume_requested',
        'continue_requested',
      ])
      .optional(),
  })
  .strict();
export type AgentRunSegmentPayloadT = z.infer<typeof AgentRunSegmentPayload>;

/**
 * `agent.terminal_request` — model-declared run-stop request (R2-6). The
 * model may not emit session-scope errors itself; the tool records this
 * marker instead and the orchestrator emits the session error + fails.
 */
export const AGENT_TERMINAL_REQUEST = 'agent.terminal_request' as const;
export const AgentTerminalRequestPayload = z
  .object({
    code: IngestionAgentErrorCode,
    reason: z.string().optional(),
  })
  .strict();
export type AgentTerminalRequestPayloadT = z.infer<typeof AgentTerminalRequestPayload>;

/**
 * `agent.paid_attempt` — paid-attempt identity recorded BEFORE the model
 * call ('sent') and after it returns ('settled', carrying the task_run id).
 * Stale-segment recovery refuses to auto re-pay when a 'sent' marker exists.
 */
export const AGENT_PAID_ATTEMPT = 'agent.paid_attempt' as const;
export const AgentPaidAttemptPayload = z
  .object({
    segment: z.number().int().min(1),
    /** Deterministic per (session,segment): a redelivery marks the same attempt. */
    attempt_ref: z.string().min(1),
    phase: z.enum(['sent', 'settled']),
    task_run_id: z.string().optional(),
  })
  .strict();
export type AgentPaidAttemptPayloadT = z.infer<typeof AgentPaidAttemptPayload>;

// ---------- wire shapes for the answer endpoint ----------

export const IngestionAskAnswerResponse = z
  .object({
    accepted: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
export type IngestionAskAnswerResponseT = z.infer<typeof IngestionAskAnswerResponse>;

export const IngestionAskAnswerBody = z.object({ answer: IngestionAskAnswerPost }).strict();
export type IngestionAskAnswerBodyT = z.infer<typeof IngestionAskAnswerBody>;

export const IngestionAskAnswerHeaders = z.object({
  'Idempotency-Key': z.string().min(1).max(200),
});

export const IngestionAskParams = z.object({
  id: z.string().min(1),
  ask_id: z.string().min(1),
});

/** Answer validation error codes fixed by the contract (422). */
export const ASK_ANSWER_ERROR_CODES = [
  'option_not_found',
  'answer_empty',
  'answer_too_long',
  'answer_kind_mismatch',
] as const;
