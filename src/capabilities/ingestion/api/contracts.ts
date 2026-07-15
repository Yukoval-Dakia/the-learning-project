import { z } from 'zod';

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

export const CreateIngestionSessionBody = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(MAX_PDF_PAGES),
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

export const IngestionOperationSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    status: z.string(),
  })
  .passthrough();

/** Runtime FormData carries a File; OpenAPI renders the shared marker as format: binary. */
export const MultipartFileUploadSchema = z.object({ file: MultipartFilePartSchema }).passthrough();

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
    provenance: z.record(z.unknown()),
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

export const MistakeProjectionSchema = z.object({
  id: z.string(),
  record_id: z.string(),
  question_id: z.string(),
  prompt_md: z.string(),
  wrong_answer_md: z.string(),
  knowledge_ids: z.array(z.string()),
  cause: z
    .object({
      source: z.enum(['agent', 'user']),
      primary_category: CauseCategory,
      secondary_categories: z.array(CauseCategory),
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
