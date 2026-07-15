import { z } from 'zod';

import {
  FigureRef,
  IngestionEntrypoint,
  MAX_PDF_PAGES,
  MistakeEnrollOutcome,
  PageSpan,
  StructuredQuestion,
} from '@/kernel/capability-contract-schemas';
import { MultipartFilePartSchema } from '@/kernel/http-contracts';

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
