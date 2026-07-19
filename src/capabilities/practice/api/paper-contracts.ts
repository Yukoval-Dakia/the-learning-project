import { z } from 'zod';

import { ApiPageSchema } from '@/kernel/http-contracts';

/** Bound answer text copied into judge prompts and immutable paper events. */
export const MAX_PAPER_ANSWER_CHARS = 12_000;

export const PaperParamsSchema = z.object({ id: z.string().min(1) });

export const CreateLegacyPaperReviewSessionBodySchema = z.object({
  artifact_id: z.string().min(1),
});

export const PaperListItemSchema = z.object({
  artifact_id: z.string(),
  title: z.string(),
  source: z.enum(['coach', 'custom', 'note', 'other']),
  intent_source: z.string(),
  generation_status: z.string(),
  knowledge_ids: z.array(z.string()),
  knowledge: z.array(z.object({ id: z.string(), name: z.string() })),
  total_slots: z.number().int().nonnegative(),
  session: z
    .object({
      id: z.string(),
      status: z.string(),
      pos: z.number().int().nonnegative(),
      right: z.number().int().nonnegative(),
      wrong: z.number().int().nonnegative(),
    })
    .nullable(),
  created_at: z.string().datetime(),
});

export const PaperListResponseSchema = z.object({
  data: z.array(PaperListItemSchema),
  page: ApiPageSchema,
  papers: z.array(PaperListItemSchema),
  next_cursor: z.string().nullable(),
});

export const PaperAnswerDraftParamsSchema = z.object({
  id: z.string().min(1),
  answerId: z.string().min(1),
});

const PaperAnswerDraftBodyFields = {
  question_id: z.string().min(1),
  part_ref: z.string().min(1).nullable().optional(),
  input_kind: z.enum(['text', 'option', 'image', 'voice']).default('text'),
  content_md: z.string().max(MAX_PAPER_ANSWER_CHARS).default(''),
  image_refs: z.array(z.string()).default([]),
};

export const LegacyPaperAnswerDraftBodySchema = z.object({
  session_id: z.string().min(1),
  ...PaperAnswerDraftBodyFields,
});

export const CreatePaperAnswerDraftBodySchema = z.object({
  paper_id: z.string().min(1),
  ...PaperAnswerDraftBodyFields,
});

export const PaperAnswerDraftCreatedSchema = z.object({
  answer_id: z.string(),
  created: z.boolean(),
});

export const PaperAnswerDraftSchema = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  question_id: z.string(),
  part_ref: z.string().nullable(),
  input_kind: z.string(),
  content_md: z.string(),
  image_refs: z.array(z.string()),
  paper_artifact_id: z.string().nullable(),
  autosaved_at: z.string().datetime().nullable(),
  submitted_at: z.string().datetime().nullable(),
  event_id: z.string().nullable(),
});

const PaperSubmissionBodyFields = {
  question_id: z.string().min(1),
  part_ref: z.string().min(1).nullable().optional(),
  answer_md: z.string().max(MAX_PAPER_ANSWER_CHARS),
  image_refs: z.array(z.string()).default([]),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
};

export const LegacyPaperSubmissionBodySchema = z.object({
  session_id: z.string().min(1),
  ...PaperSubmissionBodyFields,
});

export const CreatePaperSubmissionBodySchema = z.object({
  paper_id: z.string().min(1),
  ...PaperSubmissionBodyFields,
});

const PaperSubmissionIdentitySchema = z.object({
  attempt_event_id: z.string(),
  judge_event_id: z.string(),
  answer_id: z.string(),
});

export const PaperSubmissionResponseSchema = z.discriminatedUnion('visible_to_user', [
  PaperSubmissionIdentitySchema.extend({
    visible_to_user: z.literal(true),
    coarse_outcome: z.string(),
    score: z.number().nullable(),
  }),
  PaperSubmissionIdentitySchema.extend({
    visible_to_user: z.literal(false),
    feedback_buffered: z.literal(true),
  }),
]);

const PaperQuestionFaceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  prompt_md: z.string(),
  choices_md: z.array(z.string()).nullable(),
  difficulty: z.number(),
  parent_question_id: z.string().nullable(),
  part_index: z.number().int().nullable(),
  image_refs: z.array(z.string()),
});

const PaperDraftStateSchema = z.object({
  content_md: z.string(),
  input_kind: z.string(),
  image_refs: z.array(z.string()),
});

const PaperVisibleSubmissionStateSchema = z.object({
  submitted: z.literal(true),
  visible_to_user: z.literal(true),
  outcome: z.string(),
  score: z.number().nullable(),
  feedback_md: z.string().nullable(),
  answer_md: z.string(),
  answer_image_refs: z.array(z.string()),
  reference_md: z.string().nullable(),
});

const PaperBufferedSubmissionStateSchema = z.object({
  submitted: z.literal(true),
  visible_to_user: z.literal(false),
  feedback_buffered: z.literal(true),
  answer_md: z.string(),
  answer_image_refs: z.array(z.string()),
});

const PaperSlotStateSchema = z.object({
  draft: PaperDraftStateSchema.nullable(),
  submission: z
    .discriminatedUnion('visible_to_user', [
      PaperVisibleSubmissionStateSchema,
      PaperBufferedSubmissionStateSchema,
    ])
    .nullable(),
});

const PaperDetailSlotSchema = z.object({
  question_id: z.string(),
  part_ref: z.string().nullable(),
  section_index: z.number().int().nonnegative(),
  knowledge_focus: z.array(z.string()),
  question: PaperQuestionFaceSchema,
  slot_state: PaperSlotStateSchema,
});

const PaperDetailSectionSchema = z.object({
  section_index: z.number().int().nonnegative(),
  knowledge_focus: z.array(z.string()),
  knowledge_focus_names: z.array(z.string()),
  feedback_policy: z.string(),
  slots: z.array(PaperDetailSlotSchema),
});

export const PaperDetailResponseSchema = z.object({
  artifact_id: z.string(),
  title: z.string(),
  generation_status: z.string(),
  intent_source: z.string(),
  session: z
    .object({
      id: z.string(),
      status: z.string(),
      pos: z.number().int().nonnegative(),
      right: z.number().int().nonnegative(),
      wrong: z.number().int().nonnegative(),
    })
    .nullable(),
  sections: z.array(PaperDetailSectionSchema),
  is_flat_fallback: z.boolean(),
});
