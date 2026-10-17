import { z } from 'zod';

// YUK-1522 (R8) — ingestion-agent durable event + ask contracts.
//
// The UI was built against the R8 section of
// `ui-backend-contracts-2026-10-17.md`; field names and enums here are the
// binding wire shape. Every `ingestion_agent.*` payload carries `kind` equal to
// its event_type so SSE frames are self-describing on replay.
//
// 纯 schema / 常量 / 工具函数 —— 本文件不得 import @/server/*（事件写口在
// server/events/agent-progress.ts，ask 存取在 server/agent/asks.ts）。

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

export const IngestionAgentStageCounts = z
  .object({
    segmented: z.number().int().min(0).optional(),
    structured: z.number().int().min(0).optional(),
    admitted: z.number().int().min(0).optional(),
    withheld: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    pending_ask: z.number().int().min(0).optional(),
  })
  .strict();

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
    /** 0-based source page. */
    page: z.number().int().min(0).optional(),
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
    placeholder: z.string().optional(),
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
    placeholder: z.string().optional(),
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
    /** ≥1 = physical run segment; 0 = out-of-band marker (resume_requested). */
    segment: z.number().int().min(0),
    trigger: z.enum(['start', 'resume', 'continue']),
    task_run_id: z.string().optional(),
    open_asks: z.array(z.string()).optional(),
    outcome: z.enum(['running', 'waiting', 'done', 'failed', 'resume_requested']).optional(),
  })
  .strict();
export type AgentRunSegmentPayloadT = z.infer<typeof AgentRunSegmentPayload>;

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
