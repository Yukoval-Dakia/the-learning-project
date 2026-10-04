import { z } from 'zod';

/** Learner process observations; none of these fields replace original responses. */
export const AssessmentAttemptCapture = z.object({
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
