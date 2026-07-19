import { QuestionKind } from '@/core/schema/business';
import { MAX_HINT_COUNT, MAX_HINT_INDEX } from '@/core/schema/event/known';
import { collectionResponseSchema } from '@/kernel/http-contracts';
import { z } from 'zod';

export const QuestionParamsSchema = z.object({ id: z.string().trim().min(1) });
export const SolveSessionParamsSchema = z.object({ sid: z.string().trim().min(1) });
export const QuestionSolveParamsSchema = z.object({
  id: z.string().trim().min(1),
  sid: z.string().trim().min(1),
});

const SourceTierSchema = z.coerce.number().int().min(1).max(4);

export const QuestionListQueryFieldsSchema = z.object({
  knowledge_id: z.array(z.string().min(1)).default([]),
  subject: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  difficulty: z.array(z.coerce.number().int().min(1).max(5)).default([]),
  visual_complexity: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  source_tier: z.array(SourceTierSchema).default([]),
  sort_by: z.enum(['created_at', 'source_tier', 'difficulty']).optional(),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['all', 'active', 'draft']).optional(),
  group_by_family: z.boolean().default(false),
  expand_root: z.string().min(1).optional(),
  include_drafts: z.boolean().default(false),
  enrich: z.boolean().default(false),
  limit: z.coerce.number().int().default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().min(1).optional(),
});

export const QuestionListQuerySchema = QuestionListQueryFieldsSchema.refine(
  (value) => !(value.expand_root !== undefined && value.group_by_family),
  { message: 'expand_root and group_by_family are mutually exclusive' },
)
  .refine((value) => !(value.expand_root !== undefined && value.source_tier.length > 0), {
    message: 'expand_root cannot be combined with source_tier',
  })
  .refine((value) => !(value.expand_root !== undefined && value.sort_by !== undefined), {
    message: 'expand_root cannot be combined with sort_by',
  });

export const QuestionListEntrySchema = z.union([
  z.object({ id: z.string() }).passthrough(),
  z.object({ root_question_id: z.string() }).passthrough(),
]);
export const QuestionListResponseSchema = collectionResponseSchema(QuestionListEntrySchema);

export const QuestionDetailQuerySchema = z.object({
  // The detail reader accepts larger values and clamps them to 50.
  timeline_limit: z.coerce.number().int().min(1).optional(),
});

export const QuestionDetailResponseSchema = z
  .object({
    id: z.string(),
    subject: z.string().nullable(),
    kind: z.string(),
    prompt_md: z.string(),
    difficulty: z.number().int(),
    version: z.number().int().nonnegative(),
    knowledge_ids: z.array(z.string()),
  })
  .passthrough();

export const UpdateQuestionBodySchema = z
  .object({
    version: z.number().int().min(0),
    prompt_md: z.string().min(1).optional(),
    reference_md: z.string().nullable().optional(),
    choices_md: z.array(z.string().min(1)).nullable().optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    knowledge_ids: z.array(z.string().min(1)).optional(),
    kind: QuestionKind.optional(),
    draft_status: z.enum(['draft', 'active']).nullable().optional(),
  })
  .strict();

export const UpdateQuestionResponseSchema = z.object({
  ok: z.literal(true),
  noop: z.boolean(),
  version: z.number().int().nonnegative(),
  event_id: z.string().optional(),
});

export const DeleteQuestionQuerySchema = z
  .object({
    confirm: z.literal('true').optional(),
    version: z.coerce.number().int().nonnegative().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.confirm === 'true' && query.version === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confirm=true requires version',
        path: ['version'],
      });
    }
  });

export const DeleteQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    archived: z.literal(true),
    event_id: z.string(),
    cascaded_part_ids: z.array(z.string()),
    associations: z.record(z.number().int().nonnegative()),
  })
  .passthrough();

export const StartSolveBodySchema = z.object({ regenerate: z.boolean().optional() }).nullable();
export const CreateSolveSessionBodySchema = z.object({
  question_id: z.string().trim().min(1),
  regenerate: z.boolean().optional(),
});
export const SolveSessionCreatedSchema = z.object({
  session_id: z.string(),
  generated: z.boolean(),
  generation_error: z.boolean(),
});

export const SolveSessionResponseSchema = z
  .object({
    id: z.string(),
    type: z.literal('tutor'),
    status: z.string(),
    question_id: z.string().nullable(),
  })
  .passthrough();

export const HintRequestBodySchema = z
  .object({ hint_index: z.number().int().min(0).max(MAX_HINT_INDEX).default(0) })
  .nullable();
export const CreateHintRequestBodySchema = z.object({
  question_id: z.string().trim().min(1),
  hint_index: z.number().int().min(0).max(MAX_HINT_INDEX).optional(),
});
export const HintRequestResponseSchema = z.object({
  hint_request_id: z.string(),
  text_md: z.string(),
});

export const SolveSubmissionBodySchema = z.object({
  student_text_steps: z.array(z.string()).optional(),
  student_final_answer_text: z.string().optional(),
  student_image_refs: z.array(z.string()).optional(),
  hints_used: z.number().int().nonnegative().max(MAX_HINT_COUNT).optional(),
  final_hint_level: z.number().int().nonnegative().max(MAX_HINT_INDEX).optional(),
});
export const CreateSolveSubmissionBodySchema = SolveSubmissionBodySchema.extend({
  question_id: z.string().trim().min(1),
});
export const SolveSubmissionResponseSchema = z
  .object({
    attempt_event_id: z.string(),
    judge: z.unknown(),
    revealed_solution_md: z.string().nullable(),
    mistake_id: z.string().optional(),
  })
  .passthrough();
