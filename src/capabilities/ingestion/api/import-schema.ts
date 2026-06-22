/**
 * Request-body Zod schemas for POST /api/ingestion/[id]/import.
 *
 * Extracted from route.ts (YUK-234, SEC-4) so the bounds are unit-testable in
 * isolation without standing up the route's DB/R2/AI import graph. The route
 * imports `ImportBody` from here and is otherwise unchanged.
 *
 * Bounds rationale (YUK-234): an unbounded `blocks` array (and its nested
 * arrays) let a single request balloon validation + per-block DB work without
 * limit. A real ingestion session caps at a few dozen blocks per page-set, so
 * these ceilings are generous (no legitimate request hits them) while still
 * rejecting a hostile/buggy payload before it reaches the transaction.
 */
import { z } from 'zod';

import { PageSpan } from '@/core/schema';
import { CauseCategory, QuestionKind } from '@/core/schema/business';

// T-OC slice 1 (YUK-145, OC-3): the capture outcome is a SIGNAL, not hardcoded.
// See ADR-0024 + docs/superpowers/plans/2026-05-30-yuk145-toc-slice1-lane.md.
// Default 'failure' keeps the current review UI (VisionTab) enrolling mistakes
// byte-for-byte; new values come from the review UI / slice-3 WorkflowJudge.
export const EnrollOutcomeSchema = z.enum(['failure', 'success', 'partial', 'unanswered']);

// YUK-234 (SEC-4) per-array ceilings. Generous vs any real ingestion session
// (a page-set yields a few dozen blocks; a merged virtual card pulls from a
// handful of sources / images / spans), but bounded so the wire body can't be
// used to force unbounded validation + DB work.
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
    // P3 (YUK-489): relaxed from .min(1) to allow an empty per-block array. When present the
    // client ids are authoritative (manual intent wins). When empty the import handler would run
    // the unified `tagKnowledge` to auto-attribute — but only if it can resolve a subject root.
    // See the empty-ids branch in import.ts for why import still effectively requires ids today.
    knowledge_ids: z.array(z.string().min(1)).max(MAX_KNOWLEDGE_IDS),
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
