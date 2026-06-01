// MistakeEnrollTask contract — T-OC slice A1 (YUK-145).
//
// Drafts the mistake metadata a human currently fills by hand at review time for
// a CAPTURED, ANSWERED question_block: the graded outcome, the question kind, a
// difficulty estimate, and (on a wrong answer) a cause draft. The draft is
// produced observe-only and attached to the `experimental:auto_enroll_observed`
// audit event (see src/server/ingestion/auto-enroll.ts); it never writes a domain
// row in A1. The "AI drafted N items" review surface + the actual enroll wiring
// are deferred to A2 (OC-5 UI, YUK-164) behind the OFF enroll flag.
import { z } from 'zod';

import { QuestionKind } from './business';
import { CauseCategoryId, CauseSchema } from './cause';

// ---------- Input (what the invoker passes to the model) ----------
export const MistakeEnrollInput = z.object({
  // The question text — rendered from question_block.structured upstream
  // (structuredToPromptMarkdown) or the extracted_prompt_md fallback.
  question_md: z.string().min(1),
  // Reference/model answer if extraction surfaced one (question_block.reference_md).
  reference_md: z.string().nullable().default(null),
  // The student's captured answer (question_block.wrong_answer_md). Blank/null
  // means unanswered — the invoker forces outcome 'unanswered' + cause null.
  student_answer_md: z.string().nullable().default(null),
  // The subject's allowed cause taxonomy ids (profile.causeCategories[].id) —
  // an anti-hallucination belt; the invoker re-clamps server-side too.
  allowed_cause_ids: z.array(CauseCategoryId).min(1),
  // Knowledge ids the WorkflowJudge already accepted, for cause grounding.
  knowledge_ids: z.array(z.string().min(1)).default([]),
});
export type MistakeEnrollInputT = z.infer<typeof MistakeEnrollInput>;

// Drafted grade of the captured answer. Maps to EnrollOutcome downstream (A2).
export const MistakeEnrollOutcome = z.enum(['failure', 'partial', 'success', 'unanswered']);
export type MistakeEnrollOutcomeT = z.infer<typeof MistakeEnrollOutcome>;

// ---------- Output (the model's structured JSON, post-validation) ----------
export const MistakeEnrollOutput = z.object({
  wrong_answer: MistakeEnrollOutcome,
  question_type: QuestionKind,
  difficulty: z.number().int().min(1).max(5),
  // Reuses the canonical CauseSchema. Non-null only when wrong_answer ==='failure'
  // (the invoker enforces null otherwise); clamped to allowed_cause_ids server-side.
  cause: CauseSchema.nullable().default(null),
  // Top-level sortable confidence so the A2 review surface can threshold/sort
  // drafts regardless of outcome (cause.confidence only exists on failures).
  overall_confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
});
export type MistakeEnrollOutputT = z.infer<typeof MistakeEnrollOutput>;
