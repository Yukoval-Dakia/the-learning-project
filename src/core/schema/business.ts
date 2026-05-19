import { z } from 'zod';
import { CauseCategory } from './cause';
export {
  CauseCategory,
  CauseCategoryId,
  CauseSchema,
  getAllowedCauseIds,
  getCauseLabel,
  getCausePriority,
  UNIVERSAL_CAUSE_IDS,
  UNIVERSAL_CAUSE_LABELS,
  UNIVERSAL_CAUSE_PRIORITY,
  validateCauseAgainstProfile,
} from './cause';
export type { CauseCategoryT, CauseSchemaT, UniversalCauseId } from './cause';

// ---------- 业务 enum ----------

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

export const LearningItemSource = z.enum(['mistake', 'manual', 'learning_intent', 'ai_dream']);

export const LearningItemStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'dismissed',
  'resting',
  'archived',
]);

export const LearningRecordKind = z.enum([
  'mistake',
  'worked_example',
  'open_question',
  'insight',
  'reflection',
  'observation',
  'resource_note',
]);

export const LearningRecordSource = z.enum(['manual', 'ocr', 'import', 'conversation', 'agent']);

export const LearningRecordCaptureMode = z.enum([
  'text',
  'image',
  'paper',
  'voice',
  'url',
  'mixed',
]);

export const LearningRecordActivityKind = z.enum([
  'attempt',
  'review',
  'read',
  'ask',
  'annotate',
  'import',
  'conversation',
  'plan',
]);

export const LearningRecordProcessingStatus = z.enum(['raw', 'linked', 'actioned', 'archived']);

export const MemoryBriefScopeKey = z.string().regex(/^(global|subject:[a-zA-Z0-9_-]+)$/);

export const ArtifactType = z.enum(['note_hub', 'note_atomic', 'tool_quiz']);

export const SourceAssetKind = z.enum(['image', 'pdf', 'text', 'web']);

export const IngestionSessionStatus = z.enum([
  'uploaded',
  'queued',
  'extracting',
  'extracted',
  'partial',
  'reviewed',
  'imported',
  'failed',
]);

export const IngestionEntrypoint = z.enum(['vision_single', 'vision_paper']);

export const QuestionBlockStatus = z.enum(['draft', 'imported', 'ignored']);

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
// elapsed_days is deprecated in ts-fsrs v6 — kept optional for forward compat.
export const FsrsState = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number().optional(),
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

// AgentRef: a uniform "who did this" stamp on question.created_by /
// judgment.judged_by / artifact.generated_by. Catchall allows callers to add
// task-specific fields without bumping the schema; required keys are the
// minimum any consumer can rely on.
export const AgentRef = z
  .object({
    by: z.enum(['ai', 'user', 'system']),
    task_kind: z.string().optional(),
    model: z.string().optional(),
    task_run_id: z.string().optional(),
  })
  .catchall(z.unknown());

// ArtifactHistoryEntry: one entry in artifact.history. Keeps the snapshot
// shape open (artifacts have many sub-kinds) but pins the bookkeeping fields
// so callers can rely on `version` + `at` to render a timeline.
export const ArtifactHistoryEntry = z
  .object({
    version: z.number().int().nonnegative(),
    at: z.coerce.date(),
    by: AgentRef.optional(),
    summary_md: z.string().optional(),
  })
  .catchall(z.unknown());

// Provenance: lineage of an asset / document — minimal pinned fields, rest
// open. Source-specific fields (ocr_engine, http_status, etc.) live in the
// catchall so we don't fork the schema per source kind.
export const Provenance = z
  .object({
    captured_at: z.coerce.date().optional(),
    captured_by: AgentRef.optional(),
    source_kind: z.string().optional(),
  })
  .catchall(z.unknown());
