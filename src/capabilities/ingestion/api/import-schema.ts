/**
 * Request-body schemas for the import route. They live here so bounds can be
 * tested without the route's DB/R2/AI graph.
 *
 * The array ceilings are far above a real session but stop a hostile payload from
 * forcing unbounded validation and per-block DB work.
 */
import { z } from 'zod';

import { CauseCategory, PageSpan, QuestionKind } from '@/kernel/capability-contract-schemas';

// The capture outcome is a signal (ADR-0024). Defaulting to failure keeps the
// existing review UI behavior unchanged.
export const EnrollOutcomeSchema = z.enum(['failure', 'success', 'partial', 'unanswered']);

// Per-array ceilings: generous for real sessions, bounded so the wire body cannot
// force unbounded validation and DB work.
const MAX_BLOCKS = 200;
const MAX_SOURCE_BLOCK_IDS = 200;
const MAX_PAGE_SPANS = 100;
const MAX_IMAGE_REFS = 100;
const MAX_KNOWLEDGE_IDS = 100;

export const ImportBlock = z
  .object({
    block_id: z.string().min(1).optional(),
    source_block_ids: z.array(z.string().min(1)).max(MAX_SOURCE_BLOCK_IDS),
    page_spans: z.array(PageSpan).min(1).max(MAX_PAGE_SPANS),
    image_refs: z.array(z.string().min(1)).max(MAX_IMAGE_REFS),
    final_prompt_md: z.string().min(1),
    final_reference_md: z.string().nullable(),
    // For an `unanswered` capture (item bank / to-practice) there is no answer,
    // so empty is allowed; otherwise the answer markdown is required.
    final_wrong_answer_md: z.string(),
    outcome: EnrollOutcomeSchema.default('failure'),
    // At least one id: import has no subject signal, so tagKnowledge cannot resolve
    // a PROPOSE parent for an empty set.
    knowledge_ids: z
      .array(z.string().min(1))
      .min(1, 'Array must contain at least 1 element(s)')
      .max(MAX_KNOWLEDGE_IDS),
    cause: z
      .object({
        primary_category: CauseCategory,
        user_notes: z.string().nullable(),
      })
      .nullable(),
    difficulty: z.number().int().min(1).max(5).default(3),
    question_kind: QuestionKind,
  })
  .superRefine((block, ctx) => {
    if (block.outcome !== 'unanswered' && block.final_wrong_answer_md.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "final_wrong_answer_md is required unless outcome='unanswered'",
        path: ['final_wrong_answer_md'],
      });
    }
  });

export const ImportBody = z.object({
  blocks: z.array(ImportBlock).min(1).max(MAX_BLOCKS),
});

export type ImportBodyInput = z.input<typeof ImportBody>;
export type ImportBodyParsed = z.infer<typeof ImportBody>;
