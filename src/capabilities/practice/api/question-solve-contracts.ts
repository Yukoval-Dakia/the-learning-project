import { QuestionKind } from '@/core/schema/business';
import { MAX_HINT_COUNT, MAX_HINT_INDEX } from '@/core/schema/event/known';
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

const QuestionListBaseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  prompt_md: z.string(),
  source: z.string(),
  source_tier: z.object({ tier: SourceTierSchema, name: z.string() }),
  difficulty: z.number().int().min(1).max(5),
  visual_complexity: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
  root_question_id: z.string().nullable(),
  variant_depth: z.number().int().nonnegative(),
  parent_question_id: z.string().nullable(),
  part_index: z.number().int().nullable(),
  draft_status: z.string().nullable(),
  created_at_sec: z.number(),
  subject: z.string().nullable(),
  notation: z.string().nullable(),
  knowledge_labels: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
  is_composite: z.boolean(),
});

// Composite parts cannot recursively contain parts, so the one-level child
// schema remains fully typed without an OpenAPI recursive-reference fallback.
const QuestionListChildSchema = QuestionListBaseSchema.extend({
  children: z.array(z.never()),
});

export const QuestionListItemSchema = QuestionListBaseSchema.extend({
  children: z.array(QuestionListChildSchema),
});

export const QuestionFamilySchema = z.object({
  root_question_id: z.string(),
  root_prompt_md: z.string(),
  variant_count: z.number().int().nonnegative(),
  max_variant_depth: z.number().int().nonnegative(),
  member_ids: z.array(z.string()),
  representative: QuestionListItemSchema,
});

const QuestionListPageSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

export const QuestionListResponseSchema = z.object({
  data: z.array(z.union([QuestionListItemSchema, QuestionFamilySchema])),
  items: z.array(QuestionListItemSchema),
  families: z.array(QuestionFamilySchema).nullable(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  page: QuestionListPageSchema,
  computed_at_sec: z.number(),
});

export const QuestionDetailQuerySchema = z.object({
  // The detail reader accepts larger values and clamps them to 50.
  timeline_limit: z.coerce.number().int().min(1).optional(),
  // Product-owned intervention diagnostics stay absent from the question-bank
  // surface. The canonical Practice face may request a learner-safe projection
  // so the due one-shot can still be answered through the existing PfSolo flow.
  surface: z.literal('practice').optional(),
});

export const QuestionDetailResponseSchema = z
  .object({
    id: z.string(),
    subject: z.string().nullable(),
    notation: z.string().nullable(),
    kind: z.string(),
    prompt_md: z.string(),
    reference_md: z.string().nullable(),
    choices_md: z.array(z.string()).nullable(),
    rubric_json: z.unknown(),
    difficulty: z.number().int(),
    source: z.string(),
    source_ref: z.string().nullable(),
    source_tier: z.object({ tier: z.number().int(), name: z.string() }),
    visual_complexity: z.string().nullable(),
    figures: z.unknown(),
    image_refs: z.array(z.string()),
    variant_depth: z.number().int().nonnegative(),
    root_question_id: z.string().nullable(),
    parent_variant_id: z.string().nullable(),
    parent_question_id: z.string().nullable(),
    part_index: z.number().int().nullable(),
    parts: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        part_index: z.number().int(),
        prompt_md: z.string(),
        difficulty: z.number().int(),
        draft_status: z.string().nullable(),
      }),
    ),
    draft_status: z.string().nullable(),
    version: z.number().int().nonnegative(),
    knowledge_ids: z.array(z.string()),
    labels: z.array(z.object({ id: z.string(), name: z.string() })),
    family: z.object({
      root_question_id: z.string(),
      members: z.array(
        z.object({
          id: z.string(),
          variant_depth: z.number().int().nonnegative(),
          kind: z.string(),
          is_self: z.boolean(),
        }),
      ),
      variant_count: z.number().int().nonnegative(),
    }),
    scheduling: z.object({
      per_knowledge: z.array(
        z.object({
          knowledge_id: z.string(),
          name: z.string().nullable(),
          mastery: z.number().nullable(),
          evidence_count: z.number().int().nonnegative(),
          last_evidence_at_sec: z.number().nullable(),
          decay_bucket: z.string(),
          due_at_sec: z.number().nullable(),
        }),
      ),
      aggregate_decay_bucket: z.string(),
      legacy_question_fsrs: z.object({ due_at_sec: z.number() }).nullable(),
    }),
    backlinks: z.array(
      z.object({
        artifact_id: z.string(),
        type: z.string(),
        title: z.string(),
        tool_kind: z.string().nullable(),
        intent_source: z.string(),
        generation_status: z.string(),
        created_at_sec: z.number(),
      }),
    ),
    backlinks_by_intent_source: z.record(
      z.string(),
      z.array(
        z.object({
          artifact_id: z.string(),
          type: z.string(),
          title: z.string(),
          tool_kind: z.string().nullable(),
          intent_source: z.string(),
          generation_status: z.string(),
          created_at_sec: z.number(),
        }),
      ),
    ),
    timeline: z.array(
      z.object({
        kind: z.enum(['attempt', 'review']),
        event_id: z.string(),
        created_at_sec: z.number(),
        outcome: z.string(),
        duration_ms: z.number().nullable(),
        cause: z
          .object({ primary: z.string(), confidence: z.number().nullable() })
          .nullable()
          .optional(),
        fsrs_rating: z.enum(['again', 'hard', 'good']).optional(),
      }),
    ),
    committed_attempt: z
      .object({
        review_event: z
          .object({
            id: z.string(),
            rating: z.enum(['again', 'hard', 'good']),
          })
          .strict(),
        judge: z
          .object({
            route: z.literal('multimodal_direct'),
            coarse_outcome: z.enum(['correct', 'partial', 'incorrect']),
            confidence: z.number().min(0).max(1),
            feedback_md: z.string(),
            suggested_rating: z.enum(['again', 'hard', 'good']),
            judge_event_id: z.string(),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    created_at_sec: z.number(),
    updated_at_sec: z.number(),
    computed_at_sec: z.number(),
  })
  .strict();

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
