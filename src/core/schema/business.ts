import { z } from 'zod';

// ---------- 业务 enum ----------

export const CauseCategory = z.enum([
  'concept',
  'knowledge_gap',
  'calculation',
  'reading',
  'memory',
  'expression',
  'method',
  'carelessness',
  'time_pressure',
  'other',
]);

export const QuestionKind = z.enum([
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
]);

export const QuestionSource = z.enum([
  'embedded',
  'daily',
  'final',
  'dreaming',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
  'mistake_variant',
]);

export const MistakeSource = z.enum([
  'quiz_answer',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
]);

export const MistakeStatus = z.enum(['draft', 'active', 'resting', 'archived']);

export const LearningItemSource = z.enum([
  'mistake',
  'manual',
  'learning_intent',
  'ai_dream',
]);

export const LearningItemStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'dismissed',
  'resting',
  'archived',
]);

export const StudyLogKind = z.enum([
  'highlight',
  'insight',
  'question',
  'reflection',
  'observation',
]);

export const ArtifactType = z.enum(['note_hub', 'note_atomic', 'tool_quiz']);

export const SourceAssetKind = z.enum(['image', 'pdf', 'text', 'web']);

export const IngestionSessionStatus = z.enum([
  'uploaded',
  'extracted',
  'reviewed',
  'imported',
  'failed',
]);

export const IngestionEntrypoint = z.enum(['vision_single', 'vision_paper']);

export const QuestionBlockStatus = z.enum([
  'draft',
  'reviewed',
  'merged',
  'imported',
  'ignored',
]);

export const QuestionBlockRole = z.enum(['prompt', 'answer_area', 'continuation']);

export const VisualComplexity = z.enum(['low', 'medium', 'high']);

export const JudgeKind = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'multimodal_direct',
  'ai_flexible',
]);

export const DreamingProposalKind = z.enum([
  'problem',
  'knowledge',
  'quiz',
  'summary',
  'note_section_update',
  'learning_item_completion',
  'learning_item_relearn',
]);

// ---------- JSON 内层 schema ----------

export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
});

export const Cause = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string(),
  user_notes: z.string().nullish(),
  partial: z.boolean().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  user_edited: z.boolean().default(false),
});

export const FsrsRating = z.enum(['again', 'hard', 'good']);
export const FsrsCardState = z.enum(['new', 'learning', 'review', 'relearning']);

// Mirrors ts-fsrs v5 Card. JSON column reads must FsrsState.parse() to coerce
// ISO strings back to Date — z.coerce.date() handles that.
export const FsrsState = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: FsrsCardState,
  last_review: z.coerce.date().nullable(),
});

export const MistakeVariant = z.object({
  question_id: z.string(),
  status: z.enum(['draft', 'active', 'broken', 'dismissed']),
  failure_reasons: z.array(z.string()).default([]),
});

export const NoteSection = z.object({
  id: z.string(),
  kind: z.enum(['definition', 'mechanism', 'example', 'pitfall', 'check']),
  body_md: z.string(),
  source_tier: z.enum(['llm_only', 'search_grounded', 'textbook', 'user_verified']),
  user_verified: z.boolean().default(false),
  embedded_check: z.object({ question_ids: z.array(z.string()) }).nullish(),
  version: z.number().int().nonnegative(),
});

export const ToolState = z.object({
  question_ids: z.array(z.string()),
  session_meta: z.record(z.unknown()).nullish(),
});
