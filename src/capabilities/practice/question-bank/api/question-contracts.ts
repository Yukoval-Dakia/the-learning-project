import { z } from 'zod';
import { ResponseSpec } from '@/core/schema/assessment/response';
import { QuestionKind } from '@/core/schema/business';
import { GradingProvenanceEntry } from '@/core/schema/capability';
import { ReviewTimingJsonSchema } from '@/core/schema/learner-judgment';

export const QuestionParamsSchema = z.object({ id: z.string().trim().min(1) });

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
  // 'not_servable' lists only held questions (in-memory serve gate,
  // not SQL-paginated; cursor pagination is rejected upstream for it).
  status: z.enum(['all', 'active', 'draft', 'not_servable']).optional(),
  group_by_family: z.boolean().default(false),
  expand_root: z.string().min(1).optional(),
  include_drafts: z.boolean().default(false),
  include_serving_counts: z.boolean().default(false),
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

// ── serving hold projection (serving-holds UI contract v2) ───────────────────
export const QuestionHoldReasonSchema = z.enum([
  'awaiting_admission',
  'admission_failed',
  'admission_undecided',
  'source_check_failed',
  'verify_hold',
  'retraction_hold',
  'no_input_renderer',
  'invalid_presentation',
  'withdrawn',
]);
export const QuestionServingCommandSchema = z.enum([
  'reverify',
  'recheck_source',
  'release_verify_hold',
]);
export const QuestionServingActionRefSchema = z.object({
  command: QuestionServingCommandSchema,
  method: z.literal('POST'),
  path: z.string(),
});
export const QuestionAdmissionWaitSchema = z.object({
  reason: z.enum(['quota', 'login', 'not_sent', 'provider']),
  retry_at: z.string().nullable(),
  recovery_action: z.enum(['wait_for_retry', 'reauthenticate', 'confirm_recovery']),
});
export const QuestionAdmissionReadSchema = z.object({
  status: z.enum(['pending', 'admitted', 'failed', 'undecided']),
  reason: z.string().nullable(),
  /** Provider/quota/login wait facts while the check is pending. */
  wait: QuestionAdmissionWaitSchema.nullable().optional(),
  /** Why an undecided admission is undecided (unknown outcome vs denied purpose). */
  cause: z.enum(['outcome_unconfirmed', 'purpose_denied']).nullable().optional(),
});
export const QuestionServingSchema = z.object({
  servable: z.boolean(),
  hold_reason: QuestionHoldReasonSchema.nullable(),
  held_since: z.string().nullable(),
  next_action: QuestionServingActionRefSchema.nullable(),
  pending_action: z.object({ command: QuestionServingCommandSchema, since: z.string() }).nullable(),
  admission: QuestionAdmissionReadSchema.nullable().optional(),
});
export const QuestionServingCountsSchema = z.object({
  not_servable_total: z.number().int().nonnegative(),
  by_reason: z.record(QuestionHoldReasonSchema, z.number().int().nonnegative()),
  /** Rows with no lifecycle record (never published) — included in
   * not_servable_total, excluded from by_reason. Additive optional key. */
  legacy_unpublished: z.number().int().nonnegative().optional(),
});
export const QuestionServingActionParamsSchema = z.object({
  id: z.string().trim().min(1),
  // YUK-1664 — only the owner's verify_hold release is still a user command.
  // reverify / recheck_source run through the system's auto ledger; an
  // old-client POST of a retired command fails this schema (400).
  command: z.literal('release_verify_hold'),
});
export const QuestionServingActionHeadersSchema = z.object({
  'Idempotency-Key': z.string().min(1).max(200),
});
export const QuestionServingActionResponseSchema = z.object({
  accepted: z.boolean(),
  serving: QuestionServingSchema,
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
  // every list item carries its serving projection (group-level for
  // composite children).
  serving: QuestionServingSchema,
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
  // pagination-independent hold counts; present only when
  // status=not_servable or include_serving_counts=true.
  serving_counts: QuestionServingCountsSchema.optional(),
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
    admission_owned: z.boolean(),
    subject: z.string().nullable(),
    notation: z.string().nullable(),
    kind: z.string(),
    prompt_md: z.string(),
    reference_md: z.string().nullable(),
    choices_md: z.array(z.string()).nullable(),
    rubric_json: z.unknown().optional(),
    difficulty: z.number().int(),
    source: z.string(),
    source_ref: z.string().nullable(),
    source_tier: z.object({ tier: z.number().int(), name: z.string() }),
    visual_complexity: z.string().nullable(),
    figures: z.unknown().optional(),
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
        // part-ness authority (FK), never the display-only kind label.
        parent_question_id: z.string().nullable(),
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
          // part-ness authority (FK) for members that are themselves
          // composite parts; the UI must not string-match kind.
          parent_question_id: z.string().nullable(),
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
          review_timing: ReviewTimingJsonSchema,
        }),
      ),
      aggregate_decay_bucket: z.string(),
      legacy_question_fsrs: z
        .object({ due_at_sec: z.number(), review_timing: ReviewTimingJsonSchema })
        .nullable(),
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
          .object({
            primary: z.string(),
            confidence: z.number().nullable(),
            // misc_ id 显示回填（active misconception title）。
            primary_label: z.string().nullable(),
            // 副归因 id + misc_ 显示回填（id→title Record map）。
            secondary: z.array(z.string()),
            secondary_labels: z.record(z.string(), z.string()),
          })
          .nullable()
          .optional(),
        assessment: z
          .object({
            evaluation_group_id: z.string(),
            original_evaluation_id: z.string().nullable(),
            effective_evaluation_id: z.string().nullable(),
          })
          .optional(),
        fsrs_rating: z.enum(['again', 'hard', 'good']).optional(),
      }),
    ),
    committed_attempt: z
      .object({
        review_event: z
          .object({
            id: z.string(),
            rating: z.enum(['again', 'hard', 'good']).nullable(),
          })
          .strict(),
        judge: z
          .object({
            route: z.enum(['multimodal_direct', 'evaluate_submission']),
            coarse_outcome: z.enum(['correct', 'partial', 'incorrect', 'unsupported']),
            confidence: z.number().min(0).max(1),
            feedback_md: z.string(),
            suggested_rating: z.enum(['again', 'hard', 'good']).nullable(),
            judge_event_id: z.string().nullable(),
            evaluation_id: z.string().optional(),
            grading_provenance: z.array(GradingProvenanceEntry).optional(),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    /** Auto-enroll judge confidence (0..1); null for questions that were not auto-enrolled. */
    ingestion_judge_confidence: z.number().nullable(),
    created_at_sec: z.number(),
    updated_at_sec: z.number(),
    computed_at_sec: z.number(),
    // same serving projection as the list items.
    serving: QuestionServingSchema,
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
    associations: z.record(z.string(), z.number().int().nonnegative()),
  })
  .passthrough();

export const RestoreQuestionBodySchema = z
  .object({
    version: z.number().int().nonnegative(),
  })
  .strict();

export const RestoreQuestionResponseSchema = z
  .object({
    ok: z.literal(true),
    restored: z.literal(true),
    event_id: z.string(),
  })
  .passthrough();

export const QuestionCardQuerySchema = z.object({
  session_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});

export const QuestionCardResponseSchema = z.object({
  question_id: z.string(),
  inline_block_ref: z
    .string()
    .regex(/^blk_[0-9a-f]{32}$/)
    .nullable(),
  state: z.enum(['ready', 'checking', 'failed', 'undecided', 'withdrawn', 'unavailable']),
  question: z
    .object({
      id: z.string(),
      group_id: z.string(),
      part_ids: z.array(z.string()).optional(),
      prompt_md: z.string(),
      blank_order: z.array(z.string().min(1)).optional(),
      admission_owned: z.boolean(),
      kind: z.string(),
      choices_md: z.array(z.string()).nullable(),
      notation: z.string().nullable(),
      inline_supported: z.boolean(),
      display_response_spec: ResponseSpec.nullable(),
    })
    .nullable(),
  serving: QuestionServingSchema.nullable(),
  latest_attempt: z
    .object({
      issuance_id: z.string(),
      revision_id: z.string(),
      part_ids: z.array(z.string()),
      status: z.enum(['issued', 'answer_saved', 'graded_unconfirmed', 'submitted']),
    })
    .nullable(),
});
