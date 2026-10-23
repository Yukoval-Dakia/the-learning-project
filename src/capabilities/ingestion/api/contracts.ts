import { z } from 'zod';
import { PublicMaterialView } from '@/core/schema/assessment';
import {
  CauseCategory,
  FigureRef,
  IngestionEntrypoint,
  MAX_PDF_PAGES,
  MistakeEnrollOutcome,
  PageSpan,
  QuestionKind,
  StructuredQuestion,
} from '@/kernel/capability-contract-schemas';
import {
  ApiPageSchema,
  BinaryResponseSchema,
  MultipartFilePartSchema,
} from '@/kernel/http-contracts';
import {
  IngestionAskAnswer,
  IngestionAskAnswerBody,
  IngestionAskAnswerHeaders,
  IngestionAskAnswerResponse,
  IngestionAskParams,
} from '../server/agent/contract';

/**
 * Client-facing consent enum. Local on purpose: callers may only declare allow or
 * answer_only, and widening the shared policy must not admit system states such as
 * crisis as client consent.
 */
export const IngestionDerivationPolicy = z.enum(['allow', 'answer_only']);

export const CreateIngestionSessionBody = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(MAX_PDF_PAGES),
  // Optional subject. Null or absent means no signal; a value must resolve to a
  // selectable subject before any write, or the request is rejected.
  subject_id: z.string().nullable().optional(),
  // Consented usage, persisted on document provenance. Allow (default) feeds
  // derived records into memory/briefs; answer_only keeps them out.
  derivation_policy: IngestionDerivationPolicy.optional(),
});

export const IngestionSessionTitleSourceSchema = z.enum([
  'source_document',
  'agent_item_preview',
  'extracted_prompt_md',
]);
export type IngestionSessionTitleSource = z.infer<typeof IngestionSessionTitleSourceSchema>;

export const IngestionSessionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    entrypoint: z.string().nullable(),
    source_document_id: z.string().nullable().optional(),
    source_asset_ids: z.array(z.string()),
    // List-only evidence fields (listIngestionSessions): which durable lane
    // produced the session, proven title source, produced-item count, and
    // lifecycle timestamps. Absent on create/detail echoes.
    path: z.enum(['agent', 'extract']).nullable().optional(),
    title: z.string().nullable().optional(),
    title_source: IngestionSessionTitleSourceSchema.nullable().optional(),
    item_count: z.number().int().min(0).optional(),
    started_at: z.number().int().optional(),
    ended_at: z.number().int().nullable().optional(),
  })
  .passthrough();

export const IngestionSessionResponseSchema = z.object({
  session: IngestionSessionSchema,
});

/**
 * The latest usage receipt for the session document. derivation_policy is the
 * document's live policy, so a later withdrawal shows immediately. Counts only;
 * redacted values never go on the wire.
 */
export const IngestionUsageReceiptSchema = z.object({
  derivation_policy: IngestionDerivationPolicy,
  /** Extraction engine that produced this receipt (e.g. tencent / glm / docx_text). */
  engine: z.string().nullable(),
  /** Channels that left the server; page images are raw, text is redacted. */
  channels: z
    .object({
      page_images: z.enum(['raw', 'none']),
      extracted_text: z.enum(['redacted', 'none']),
    })
    .nullable(),
  redacted_fields: z.array(z.string()),
  redaction_counts: z.record(z.string(), z.number()),
  recorded_at: z.string().datetime(),
});

export const IngestionSessionDetailResponseSchema = z.object({
  session: IngestionSessionSchema,
  usage_receipt: IngestionUsageReceiptSchema.nullable(),
});

const IngestionOperationBaseSchema = z
  .object({
    id: z.string(),
    kind: z.literal('ingestion_operation'),
    operation_kind: z.enum(['extract', 'agent', 'review', 'import', 'make_paper', 'rescue']),
    session_id: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), status: z.number().int() }).optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    events_url: z.string(),
  })
  .passthrough();

export const IngestionOperationSchema = z.union([
  IngestionOperationBaseSchema.extend({
    operation_kind: z.enum(['extract', 'agent', 'import', 'make_paper', 'rescue']),
  }),
  IngestionOperationBaseSchema.extend({
    operation_kind: z.literal('review'),
    status: z.enum(['queued', 'running', 'failed']),
  }),
  IngestionOperationBaseSchema.extend({
    operation_kind: z.literal('review'),
    status: z.literal('succeeded'),
    result: z.object({ status: z.literal('reviewed') }),
  }),
]);

/** Runtime FormData carries a File; OpenAPI renders the shared marker as format: binary. */
export const MultipartFileUploadSchema = z.object({ file: MultipartFilePartSchema }).passthrough();

// The docx multipart declares optional consent next to the file; the route
// rejects unknown values, and the catchall admits other form parts.
export const MultipartDocxUploadSchema = MultipartFileUploadSchema.extend({
  derivation_policy: IngestionDerivationPolicy.optional(),
});

export const SourceAssetSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    storage_key: z.string(),
    mime_type: z.string(),
    byte_size: z.number().int().nonnegative(),
    sha256: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    provenance: z.record(z.string(), z.unknown()),
    created_at: z.string().datetime(),
  })
  .passthrough();

export const AssetUploadResponseSchema = z.object({ asset: SourceAssetSchema });
export const AssetDeleteResponseSchema = z.object({ ok: z.literal(true) });
export const AssetContentResponseSchema = BinaryResponseSchema;

export const CreateMistakeBodySchema = z.object({
  prompt_md: z.string().min(1, 'prompt_md is required'),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().min(1, 'wrong_answer_md is required'),
  // No subject signal here, so at least one knowledge id is required.
  knowledge_ids: z.array(z.string().min(1)).min(1, 'at least one knowledge_id is required'),
  cause: z
    .object({
      primary_category: CauseCategory,
      user_notes: z.string().nullable(),
    })
    .nullable(),
  difficulty: z.number().int().min(1).max(5),
  question_kind: QuestionKind,
  prompt_image_refs: z.array(z.string().min(1)).default([]),
  wrong_answer_image_refs: z.array(z.string().min(1)).default([]),
});

export const MistakeListQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .refine((value) => value === undefined || /^\d+$/.test(value), {
      message: 'limit must be a positive integer',
    }),
  since: z
    .string()
    .optional()
    .refine((value) => value === undefined || !Number.isNaN(new Date(value).getTime()), {
      message: 'since must be an ISO-8601 timestamp',
    }),
  question_id: z.string().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const CreateMistakeResponseSchema = z.object({
  question_id: z.string(),
  mistake_id: z.string(),
  record_id: z.string(),
});

const MistakeCorrectionStepSchema = z.object({
  event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
});

const MistakeCorrectionStateSchema = z.object({
  original_event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded', 'missing', 'cycle']),
  terminal_state: z.enum(['active', 'retracted', 'marked_wrong', 'missing', 'cycle']),
  effective_event_id: z.string().nullable(),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
  chain: z.array(MistakeCorrectionStepSchema),
});

const PromptMaterialTextSchema = PublicMaterialView.omit({ asset_id: true });

/** Frozen public material only. Available means asset metadata matches; blob delivery is separate. */
export const MistakePromptMaterialSchema = z.discriminatedUnion('availability', [
  PromptMaterialTextSchema.extend({
    availability: z.literal('inline'),
    kind: PublicMaterialView.shape.kind.extract(['passage', 'table', 'plaintext']),
    content_md: z.string(),
  }).strict(),
  PublicMaterialView.extend({ availability: z.literal('available') }).strict(),
  PromptMaterialTextSchema.extend({
    // Missing row and present-but-incompatible metadata are distinct. Neither exposes a download ID.
    availability: z.enum(['missing', 'unavailable']),
  }).strict(),
]);

export const MistakeProjectionSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  question_id: z.string(),
  prompt_md: z.string(),
  prompt_materials: z.array(MistakePromptMaterialSchema).default([]),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string(),
  wrong_answer_image_refs: z.array(z.string()).default([]),
  knowledge_ids: z.array(z.string()),
  cause: z
    .object({
      source: z.enum(['agent', 'user']),
      primary_category: CauseCategory,
      // Display backfill from active misconception titles; null when not a misc id.
      primary_label: z.string().nullable(),
      secondary_categories: z.array(CauseCategory),
      // Display backfill for misc ids; absent entries fall back to raw ids.
      secondary_labels: z.record(z.string(), z.string()),
      user_notes: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
    })
    .nullable(),
  correction_state: MistakeCorrectionStateSchema,
  created_at: z.number().int().nonnegative(),
});

export const MistakeListResponseSchema = z.object({
  data: z.array(MistakeProjectionSchema),
  rows: z.array(MistakeProjectionSchema),
  page: ApiPageSchema,
  next_cursor: z.string().nullable(),
});

export type MistakeProjection = z.infer<typeof MistakeProjectionSchema>;
export type MistakeListResponse = z.infer<typeof MistakeListResponseSchema>;

export const PdfExpansionResponseSchema = z.object({
  asset_ids: z.array(z.string()).min(1).max(MAX_PDF_PAGES),
  page_count: z.number().int().min(1).max(MAX_PDF_PAGES),
});

export const DocxIngestionResponseSchema = z.object({
  session_id: z.string(),
  line: z.enum(['visual', 'text']),
  page_count: z.number().int().positive(),
});

const AutoEnrollMistakeDraftSchema = z.object({
  wrong_answer: MistakeEnrollOutcome.nullable(),
  difficulty: z.number().nullable(),
  cause: z
    .object({
      primary_category: z.string().nullable(),
      analysis_md: z.string().nullable(),
    })
    .nullable(),
});

const AutoEnrollObservationSchema = z.object({
  event_id: z.string(),
  outcome: z.string().nullable(),
  mode: z.string().nullable(),
  route: z.string().nullable(),
  confidence: z.number().nullable(),
  threshold: z.number().nullable(),
  reasoning: z.string().nullable(),
  suggested_knowledge_ids: z.array(z.string()),
  mistake_draft: AutoEnrollMistakeDraftSchema.nullable(),
  observed_at: z.string().datetime(),
});

export const IngestionBlockSchema = z
  .object({
    id: z.string(),
    version: z.number().int().nonnegative(),
    ingestion_session_id: z.string(),
    source_asset_ids: z.array(z.string()),
    page_spans: z.array(PageSpan),
    extracted_prompt_md: z.string().nullable(),
    structured: StructuredQuestion.nullable(),
    reference_md: z.string().nullable(),
    wrong_answer_md: z.string().nullable(),
    image_refs: z.array(z.string()),
    figures: z.array(FigureRef),
    layout_quality: z.enum(['structured', 'partial', 'text_only']),
    extraction_confidence: z.number(),
    status: z.enum(['draft', 'imported', 'ignored', 'auto_enrolled']),
    knowledge_hint: z.string().nullable(),
    imported_question_id: z.string().nullable(),
    imported_attempt_event_id: z.string().nullable(),
    auto_enroll_observation: AutoEnrollObservationSchema.nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .passthrough();

export const IngestionBlocksResponseSchema = z.object({ rows: z.array(IngestionBlockSchema) });

export const IngestionEventsHeadersSchema = z.object({
  'Last-Event-ID': z.string().optional(),
});

export const IngestionEventStreamResponseSchema = z.string();

export const LegacyExtractionResponseSchema = z.object({
  businessId: z.string(),
  jobId: z.string(),
});

export const LegacyImportResponseSchema = z.object({
  question_ids: z.array(z.string()),
  mistake_ids: z.array(z.string()),
  record_ids: z.array(z.string()),
});

export const LegacyMakePaperResponseSchema = z.object({ artifact_id: z.string() });

export const LegacyRescueResponseSchema = z.object({ structured: StructuredQuestion });

export const RevertAutoEnrolledBlockBodySchema = z.object({
  block_id: z.string().min(1),
  reason_md: z.string().max(2000).optional(),
});

export const RevertAutoEnrolledBlockResponseSchema = z.object({
  questionId: z.string(),
  recordId: z.string(),
  retractEventId: z.string(),
  retractedEventId: z.string(),
});

// Ask answer wire shapes, re-exported from the single agent contract source so
// this file stays the one-stop wire surface.
export const IngestionAskAnswerBodySchema = IngestionAskAnswerBody;
export const IngestionAskAnswerResponseSchema = IngestionAskAnswerResponse;
export const IngestionAskAnswerHeadersSchema = IngestionAskAnswerHeaders;
export const IngestionAskParamsSchema = IngestionAskParams;

// ---------- session history (GET /api/ingestion-sessions/:id/history) ----------
//
// Read-back contract for reopening a finished ingestion session. `state_at_finish`
// reports only frozen evidence (durable snapshot/live item-ledger status, or a
// durable link with 'unknown' when no at-finish state was captured); mutable
// question/question_block fields never substitute for it. `current` is today's
// admission/serving state — the two are never merged. `prior_runs` carries
// demoted checkpoints of earlier runs (v1 identity-less checkpoints land there
// unprovable); live rows never overlay them.

export const IngestionHistoryItemStateSchema = z.enum([
  // Agent item ledger statuses (agent contract vocabulary).
  'queued',
  'structuring',
  'solving',
  'calibrating',
  'admitted',
  'withheld',
  'failed',
  // question_block.status (extract lane and unclaimed drafts).
  'draft',
  'imported',
  'ignored',
  'auto_enrolled',
  // A durable link exists but no at-finish state is provable.
  'unknown',
]);

export const IngestionHistoryCurrentSchema = z
  .object({
    draft_status: z.string().nullable(),
    servable: z.boolean(),
    // SERVING_HOLD_REASONS vocabulary; null = not held for a nameable reason.
    hold_reason: z.string().nullable(),
    held_since: z.string().nullable(),
    next_action: z.object({ command: z.string(), method: z.string(), path: z.string() }).nullable(),
    pending_action: z.object({ command: z.string(), since: z.string() }).nullable(),
  })
  .strict();

export const IngestionHistoryItemSchema = z
  .object({
    item_id: z.string(),
    /** 0-based display order within the session. */
    ordinal: z.number().int().min(0),
    question_no: z.string().nullable(),
    /** 1-based source page when provenance records one. */
    page: z.number().int().min(1).nullable(),
    source_asset_ids: z.array(z.string()),
    preview_md: z.string().nullable(),
    preview_truncated: z.boolean(),
    state_at_finish: IngestionHistoryItemStateSchema,
    /** Model-written free-text reason (agent withheld/failed); null otherwise. */
    reason: z.string().nullable(),
    /** question_block.id — the versioned `qdraft1:` ref normalized for joins. */
    draft_block_id: z.string().nullable(),
    /** Raw durable draft ref as emitted (may be `qdraft1:<block>:<version>`). */
    draft_ref: z.string().nullable(),
    question_id: z.string().nullable(),
    status_at: z.string().nullable(),
    current: IngestionHistoryCurrentSchema.nullable(),
  })
  .strict();

export const IngestionHistoryAskSchema = z
  .object({
    ask_id: z.string(),
    item_id: z.string().nullable(),
    question_no: z.string().nullable(),
    prompt_md: z.string(),
    answer_kind: z.enum(['choice', 'short']),
    options: z.array(z.object({ id: z.string(), label_md: z.string() }).strict()).optional(),
    placeholder: z.string(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    resolved: z
      .object({
        answer: IngestionAskAnswer,
        via: z.enum(['answer', 'timeout']),
        at: z.string(),
      })
      .strict()
      .nullable(),
    /** True while no terminal resolution row exists — never inferred. */
    unresolved: z.boolean(),
    /** expires_at passed without a resolution; the sweeper window may have lapsed. */
    expired_unresolved: z.boolean(),
  })
  .strict();

export const IngestionHistoryRunSchema = z
  .object({
    /** execution_owner.run_ref of the live run; null when no owner exists. */
    run_ref: z.string().nullable(),
    run_state: z.enum(['in_progress', 'waiting', 'done', 'failed', 'lost']).nullable(),
    stage: z.string().nullable(),
    segment_count: z.number().int().min(0),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    captured_at: z.string().nullable(),
    execution_closed: z.boolean().nullable(),
    /** worker_lost settlement: a paid attempt's provider outcome was never proven. */
    paid_outcome_unknown: z.boolean(),
    /** Sticky marker: this run's durable error record was once truncated — the
     *  missing rows are gone for good, never silently unmarked. */
    errors_truncated: z.boolean(),
    counts: z
      .object({
        items_total: z.number().int().min(0),
        items_done: z.number().int().min(0),
        items_withheld: z.number().int().min(0),
        items_failed: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    segments: z.array(
      z
        .object({
          segment: z.number().int().min(0),
          trigger: z.enum(['start', 'resume', 'continue']),
          outcome: z.string().nullable(),
          task_run_id: z.string().nullable(),
          at: z.string(),
        })
        .strict(),
    ),
    errors: z.array(
      z
        .object({
          scope: z.enum(['session', 'item']),
          item_id: z.string().nullable(),
          code: z.string(),
          retryable: z.boolean(),
          at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * A demoted checkpoint of an earlier run — durable facts verbatim, no `current`
 * projection and no live overlay. `run_ref` is null for v1 (identity-less)
 * checkpoints whose run can never be proven.
 */
export const IngestionHistoryPriorRunSchema = z
  .object({
    run_ref: z.string().nullable(),
    /** That run's job_events floor; null on v1 identity-less checkpoints. */
    event_floor: z.number().int().nullable(),
    captured_at: z.string(),
    session_status: z.string(),
    run_state: z.enum(['in_progress', 'waiting', 'done', 'failed', 'lost']),
    stage: z.string().nullable(),
    execution_closed: z.boolean(),
    paid_outcome_unknown: z.boolean(),
    /** True when that run's durable error record was truncated — permanent. */
    errors_truncated: z.boolean(),
    items: z.array(
      z
        .object({
          item_id: z.string(),
          question_no: z.string(),
          status: IngestionHistoryItemStateSchema,
          reason: z.string().nullable(),
          page: z.number().int().min(1).nullable(),
          preview_md: z.string().nullable(),
          draft_ref: z.string().nullable(),
          question_id: z.string().nullable(),
          status_at: z.string().nullable(),
        })
        .strict(),
    ),
    asks: z.array(IngestionHistoryAskSchema),
    segments: z.array(
      z
        .object({
          segment: z.number().int().min(0),
          trigger: z.enum(['start', 'resume', 'continue']),
          outcome: z.string().nullable(),
          task_run_id: z.string().nullable(),
          at: z.string(),
        })
        .strict(),
    ),
    errors: z.array(
      z
        .object({
          scope: z.enum(['session', 'item']),
          item_id: z.string().nullable(),
          code: z.string(),
          retryable: z.boolean(),
          at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const IngestionSessionHistoryResponseSchema = z
  .object({
    session: z
      .object({
        id: z.string(),
        status: z.string(),
        /** Which lane produced the durable evidence; null when nothing ran yet. */
        path: z.enum(['agent', 'extract']).nullable(),
        entrypoint: z.string().nullable(),
        source_document_id: z.string().nullable(),
        source_asset_ids: z.array(z.string()),
        title: z.string().nullable(),
        title_source: IngestionSessionTitleSourceSchema.nullable(),
        started_at: z.string(),
        ended_at: z.string().nullable(),
        created_at: z.string(),
        updated_at: z.string(),
        error_message: z.string().nullable(),
        warnings: z.array(z.string()),
      })
      .strict(),
    run: IngestionHistoryRunSchema.nullable(),
    /** Earlier runs' demoted checkpoints, newest first. */
    prior_runs: z.array(IngestionHistoryPriorRunSchema),
    items: z.array(IngestionHistoryItemSchema),
    asks: z.array(IngestionHistoryAskSchema),
    evidence: z
      .object({
        snapshot: z.boolean(),
        live_events: z.boolean(),
        /** Slices with no provable data, e.g. 'run' | 'items' | 'asks' | 'snapshot'. */
        missing: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type IngestionSessionHistoryResponse = z.infer<typeof IngestionSessionHistoryResponseSchema>;
export type IngestionHistoryItem = z.infer<typeof IngestionHistoryItemSchema>;
export type IngestionHistoryItemState = z.infer<typeof IngestionHistoryItemStateSchema>;
