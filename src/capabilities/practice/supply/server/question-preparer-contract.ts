import { z } from 'zod';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';

const repair = z.object({
  repair_target: z.enum(['question_text', 'scoring_structure', 'reference_answer', 'figure']),
  broken_part: z.enum(['question', 'options', 'figure', 'scoring_unit', 'reference']),
  defect: z.enum([
    'missing_figure',
    'missing_marking',
    'missing_condition',
    'wrong_domain',
    'scoring_kind_mismatch',
    'impossible_context',
    'ambiguity',
  ]),
  fix_hint_md: z.string().min(1),
  suggested_key: z.json().optional(),
});
/** Gate-owned values are adapted here when adjudication lands; no rejection branch. */
export const AdmissionRepairReturn = z.object({
  question_id: z.string().min(1),
  revision_id: z.string().min(1),
  scoring_unit_id: z.string().min(1),
  verdict: z.literal('return_for_repair'),
  reason_md: z.string().min(1),
  repair,
  evidence_errors: z.array(
    z.object({ which: z.enum(['source_answer', 'printed_rule', 'author_key']), note: z.string() }),
  ),
});
export const QuestionPreparerJobData = z.object({
  ticket: EvidenceDemandV1,
  /** Server-written ticket event; the submission's causal anchor for admission purpose. */
  ticket_event_id: z.string().min(1).optional(),
  steering: z.array(z.json()).optional(),
  continuation: z
    .object({
      prior_job_id: z.string().min(1),
      verdict: AdmissionRepairReturn,
      simulated: z.boolean().default(false),
    })
    .optional(),
  recovery: z.object({ prior_job_id: z.string().min(1) }).optional(),
});
export type QuestionPreparerData = z.infer<typeof QuestionPreparerJobData>;
export const preparerInventoryObservation = z.object({
  search_id: z.string(),
  source: z.literal('caller_assessed'),
  accepted_refs: z.array(z.string()),
  count: z.number().int().nonnegative(),
  goal: z.number().int().nonnegative(),
});
export const preparerTerminal = z.object({
  inventory: preparerInventoryObservation.optional(),
  ticket: EvidenceDemandV1,
  /** Durable ticket binding; a continuation may not cross from an unbound segment. */
  ticket_event_id: z.string().min(1).optional(),
  task_run_id: z.string(),
  outcome: z.enum(['done', 'no_progress', 'awaiting_admission']),
  summary: z.string(),
  retryable: z.boolean().optional(),
});
