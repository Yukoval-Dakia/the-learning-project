import { z } from 'zod';

const CaptureTrace = z.object({
  source: z.literal('handwriting_trace_v1'),
  bbox: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  }),
  confidence: z.number().min(0).max(1).optional(),
});

const CaptureUnit = z.object({
  slot_id: z.string(),
  entry_kind: z.string(),
  state: z.enum(['answered', 'blank', 'unknown', 'omitted']),
  ink: z.enum(['post_correction', 'learner_work', 'teacher_mark']).nullable(),
  red_ink_mark: z.enum(['check', 'cross', 'mixed']).optional(),
  trace: CaptureTrace.optional(),
  reason: z.string().optional(),
});

/** Learner process observations; none of these fields replace original responses. */
export const AssessmentAttemptCapture = z.object({
  ingestion: z
    .object({
      block_id: z.string(),
      block_version: z.number().int().nonnegative(),
      source_document_id: z.string(),
      source_asset_ids: z.array(z.string()),
      generated_by: z.enum(['workflow_judge', 'ingestion_capture']),
      /** Per-unit handwriting evidence; unknown/failure stays explicit, never omitted. */
      unit_captures: z.array(CaptureUnit).optional(),
      red_ink_preference: z
        .enum(['post_correction', 'learner_work', 'teacher_mark'])
        .nullable()
        .optional(),
    })
    .optional(),
  paper_artifact_id: z.string().optional(),
  paper_started_at: z.string().datetime().optional(),
  paper_feedback_policy: z.string().optional(),
  part_ref: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  stream_item_id: z.string().nullable().optional(),
  response_md: z.string().nullable().optional(),
  reasoning_trace: z.string().nullable().optional(),
  self_confidence: z.number().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  hints_used: z.number().int().nonnegative().optional(),
  final_hint_level: z.number().int().nonnegative().optional(),
});
export type AssessmentAttemptCaptureT = z.infer<typeof AssessmentAttemptCapture>;
