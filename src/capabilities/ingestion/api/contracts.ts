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

/**
 * YUK-1408 — the client-facing consent enum for upload routes. Intentionally a
 * LOCAL literal, NOT the shared `DerivationPolicy` schema: ingestion callers
 * may only ever declare 'allow' | 'answer_only'. If the shared enum later
 * widens (e.g. with 'crisis'), client-sent values here must still be rejected
 * — crisis is a system-write state, never a client consent choice.
 */
export const IngestionDerivationPolicy = z.enum(['allow', 'answer_only']);

export const CreateIngestionSessionBody = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(MAX_PDF_PAGES),
  // YUK-1404 — explicit optional upload subject. Omitted / null = the learner
  // did not pick one (legacy clients, skippable choice): the upload ALWAYS
  // proceeds and no signal is persisted. A non-null value must resolve to a
  // currently selectable subject (aliases canonicalized) or the request is
  // rejected 400 before any source_document / learning_session write.
  subject_id: z.string().nullable().optional(),
  // YUK-1408 — the learner's consented usage for the uploaded document.
  // 'allow' (default when absent) lets ingestion-derived records feed
  // memory/briefs; 'answer_only' stamps every derived event so the shared
  // derivation filter keeps the document's content out of those channels.
  // Persisted on source_document.provenance.usage_policy; the consent UI reads
  // and updates it there.
  derivation_policy: IngestionDerivationPolicy.optional(),
});

export const IngestionSessionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    entrypoint: z.string().nullable(),
    source_document_id: z.string().nullable().optional(),
    source_asset_ids: z.array(z.string()),
  })
  .passthrough();

export const IngestionSessionResponseSchema = z.object({
  session: IngestionSessionSchema,
});

/**
 * YUK-1408 (S1 read side) — the latest `experimental:ingestion_usage_receipt`
 * for the session's source_document. `derivation_policy` is the document's
 * CURRENT live policy (provenance.usage_policy) — a later withdrawal shows
 * immediately — NOT the policy stamped on the receipt. Counts are numbers
 * only; redacted values are never on the wire.
 */
export const IngestionUsageReceiptSchema = z.object({
  derivation_policy: IngestionDerivationPolicy,
  /** Extraction engine that produced this receipt (e.g. tencent / glm / docx_text). */
  engine: z.string().nullable(),
  /**
   * What left the server for a model on this extraction: `page_images:'raw'`
   * means the original page image was sent as-is (OCR/VLM must see it);
   * only the extracted text is redacted. null on a receipt without channels.
   */
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

export const IngestionOperationSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    status: z.string(),
  })
  .passthrough();

/** Runtime FormData carries a File; OpenAPI renders the shared marker as format: binary. */
export const MultipartFileUploadSchema = z.object({ file: MultipartFilePartSchema }).passthrough();

// YUK-1408 — the docx multipart accepts an optional consent field alongside the
// file part so the OpenAPI client declares it (the route validates + rejects
// unknown values; the catchall stays for other form parts).
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
  // This route has no independent subject signal, so at least one knowledge id stays required.
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
      // YUK-1018 — misc_ id 的显示回填（active misconception title）；非 misc /
      // unresolvable → null，渲染层回退 primary_category 裸 id。
      primary_label: z.string().nullable(),
      secondary_categories: z.array(CauseCategory),
      // YUK-1020 — secondary_categories 里 misc_ id 的显示回填（id → active
      // misconception title Record map）；vocab / unresolvable 缺席 → 渲染裸 id。
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
