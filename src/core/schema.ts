import { z } from 'zod';

// 领域 Zod schema —— 与 docs/architecture.md § 七 数据模型骨架对齐。
// Phase 1 必需对象都在；Phase 2+（WeeklyReview 等）按需补。
// 数据库表见 src/db/schema.ts；这里负责输入校验 / 类型推导。

// ---------- 公共 ----------

export const Timestamps = z.object({
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int().nonnegative(),
});

export const SoftDelete = z.object({
  deleted_at: z.coerce.date().nullish(),
  delete_reason: z.enum(['user', 'merge', 'duplicate', 'misjudged']).nullish(),
});

// ---------- 知识图谱 ----------

export const Knowledge = z
  .object({
    id: z.string(),
    name: z.string(),
    domain: z.string(),
    parent_id: z.string().nullish(),
    base_mastery: z.number().min(0).max(1).default(0),
    ai_delta_mastery: z.number().min(-0.5).max(0.5).default(0),
    last_active_at: z.coerce.date().nullish(),
    merged_from: z.array(z.string()).default([]),
    archived_at: z.coerce.date().nullish(),
    proposed_by_ai: z.boolean().default(false),
    approval_status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
  })
  .merge(Timestamps);
export type Knowledge = z.infer<typeof Knowledge>;

// ---------- 统一题库 ----------

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

export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
});

export const Question = z
  .object({
    id: z.string(),
    kind: QuestionKind,
    prompt_md: z.string(),
    reference_md: z.string().nullish(),
    rubric_json: Rubric.nullish(),
    judge_kind_override: z.string().nullish(),
    visual_complexity: z.enum(['low', 'medium', 'high']).nullish(),
    knowledge_ids: z.array(z.string()).default([]),
    difficulty: z.number().int().min(1).max(5).default(3),
    source: QuestionSource,
    source_ref: z.string().nullish(),
    draft_status: z.enum(['draft', 'active']).nullish(),
    variant_depth: z.number().int().min(0).max(2).default(0),
    root_question_id: z.string().nullish(),
    parent_variant_id: z.string().nullish(),
    created_by: z.object({ task: z.string(), version: z.string() }).nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .merge(Timestamps);
export type Question = z.infer<typeof Question>;

// ---------- 错题（事件 + 复习态；题面在 Question） ----------

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

export const Cause = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string(),
  user_notes: z.string().nullish(),
  partial: z.boolean().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  user_edited: z.boolean().default(false),
});

export const FsrsState = z.object({
  due_at: z.coerce.date(),
  interval: z.number(),
  ease: z.number(),
  repeat: z.number(),
  lapses: z.number(),
  retrievability_at: z.coerce.date().nullish(),
});

export const MistakeSource = z.enum([
  'quiz_answer',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
]);

export const MistakeVariant = z.object({
  question_id: z.string(),
  status: z.enum(['draft', 'active', 'broken', 'dismissed']),
  failure_reasons: z.array(z.string()).default([]),
});

export const MistakeStatus = z.enum(['draft', 'active', 'resting', 'archived']);

export const Mistake = z
  .object({
    id: z.string(),
    question_id: z.string(),
    wrong_answer_md: z.string().nullish(),
    wrong_answer_image_refs: z.array(z.string()).default([]),
    source: MistakeSource,
    source_ref: z.string().nullish(),
    knowledge_ids: z.array(z.string()).default([]),
    cause: Cause.nullish(),
    fsrs_state: FsrsState.nullish(),
    variants: z.array(MistakeVariant).default([]),
    variants_generated_count: z.number().int().default(0),
    variants_max: z.number().int().default(3),
    status: MistakeStatus.default('active'),
    archived_reason: z.enum(['mastered', 'obsolete', 'user']).nullish(),
    archived_at: z.coerce.date().nullish(),
  })
  .merge(Timestamps)
  .merge(SoftDelete);
export type Mistake = z.infer<typeof Mistake>;

// ---------- 待学习列表（hub + atomic 层级，6 状态） ----------

export const LearningItemSource = z.enum(['mistake', 'manual', 'learning_intent', 'ai_dream']);
export const LearningItemStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'dismissed',
  'resting',
  'archived',
]);

export const LearningItem = z
  .object({
    id: z.string(),
    source: LearningItemSource,
    source_ref: z.string().nullish(),
    title: z.string(),
    content: z.string().default(''),
    knowledge_ids: z.array(z.string()).default([]),
    primary_artifact_id: z.string().nullish(),
    parent_learning_item_id: z.string().nullish(),
    child_learning_item_ids: z.array(z.string()).default([]),
    status: LearningItemStatus.default('pending'),
    user_pinned: z.boolean().default(false),
    ai_score: z.number().min(0).max(1).nullish(),
    due_at: z.coerce.date().nullish(),
    completed_at: z.coerce.date().nullish(),
    dismissed_at: z.coerce.date().nullish(),
    archived_at: z.coerce.date().nullish(),
    archived_reason: z.enum(['maintenance', 'user']).nullish(),
    reviewed_at: z.coerce.date().nullish(),
  })
  .merge(Timestamps);
export type LearningItem = z.infer<typeof LearningItem>;

export const CompletionEvidence = z.object({
  id: z.string(),
  learning_item_id: z.string(),
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
  evidence_json: z.record(z.unknown()).default({}),
  user_overrode_low_evidence: z.boolean().default(false),
  decided_at: z.coerce.date(),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidence>;

// ---------- StudyLog ----------

export const StudyLogKind = z.enum([
  'highlight',
  'insight',
  'question',
  'reflection',
  'observation',
]);

export const StudyLog = z
  .object({
    id: z.string(),
    kind: StudyLogKind,
    content_md: z.string(),
    knowledge_ids: z.array(z.string()).default([]),
    question_id: z.string().nullish(),
    mistake_id: z.string().nullish(),
    artifact_id: z.string().nullish(),
    learning_item_id: z.string().nullish(),
  })
  .merge(Timestamps);
export type StudyLog = z.infer<typeof StudyLog>;

// ---------- Artifact（多态：note_hub / note_atomic / tool_quiz） ----------

export const ArtifactType = z.enum(['note_hub', 'note_atomic', 'tool_quiz']);

export const NoteSection = z.object({
  id: z.string(),
  kind: z.enum(['definition', 'mechanism', 'example', 'pitfall', 'check']),
  body_md: z.string(),
  source_tier: z.enum(['llm_only', 'search_grounded', 'textbook', 'user_verified']),
  user_verified: z.boolean().default(false),
  embedded_check: z.object({ question_ids: z.array(z.string()) }).nullish(),
  version: z.number().int().nonnegative(),
});

export const Artifact = z
  .object({
    id: z.string(),
    type: ArtifactType,
    title: z.string(),
    knowledge_id: z.string().nullish(),
    parent_artifact_id: z.string().nullish(),
    child_artifact_ids: z.array(z.string()).default([]),
    intent_source: z.enum(['declared', 'from_mistake', 'from_dream']),
    source: z.string(),
    source_ref: z.string().nullish(),
    outline_json: z.unknown().nullish(),
    sections: z.array(NoteSection).nullish(),
    tool_kind: z.enum(['quiz']).nullish(),
    tool_state: z
      .object({
        question_ids: z.array(z.string()),
        session_meta: z.record(z.unknown()).nullish(),
      })
      .nullish(),
    generation_status: z.enum(['pending', 'partial', 'complete']).default('pending'),
    generated_by: z
      .object({
        task: z.string(),
        provider: z.string(),
        model: z.string(),
        prompt_version: z.string(),
      })
      .nullish(),
    history: z.array(z.unknown()).default([]),
    archived_at: z.coerce.date().nullish(),
  })
  .merge(Timestamps);
export type Artifact = z.infer<typeof Artifact>;

// ---------- tool_quiz 子系统 ----------

export const Answer = z.object({
  id: z.string(),
  question_id: z.string(),
  learning_item_id: z.string().nullish(),
  input_kind: z.enum(['text', 'option', 'image', 'voice']),
  content_md: z.string().default(''),
  image_refs: z.array(z.string()).default([]),
  vision_extracted: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  submitted_at: z.coerce.date(),
});
export type Answer = z.infer<typeof Answer>;

export const JudgeKind = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'multimodal_direct',
  'ai_flexible',
]);

export const Judgment = z.object({
  id: z.string(),
  answer_id: z.string(),
  judge_kind: JudgeKind,
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  score: z.number().min(0).max(1),
  feedback_md: z.string(),
  evidence_json: z.record(z.unknown()).default({}),
  is_flexible_fallback: z.boolean().default(false),
  triggered_by: z.enum(['initial', 'borderline', 'appeal', 'force']).nullish(),
  prior_judgment_id: z.string().nullish(),
  judged_by: z.object({
    task: z.string(),
    provider: z.string(),
    model: z.string(),
    version: z.string(),
  }),
  judged_at: z.coerce.date(),
  is_effective: z.boolean().default(true),
});
export type Judgment = z.infer<typeof Judgment>;

export const UserAppeal = z.object({
  id: z.string(),
  judgment_id: z.string(),
  reason: z.string().nullish(),
  appealed_at: z.coerce.date(),
  resolved_judgment_id: z.string().nullish(),
});
export type UserAppeal = z.infer<typeof UserAppeal>;

// ---------- Dreaming / Maintenance（Phase 2 实施，Phase 1 留 schema） ----------

export const DreamingProposalKind = z.enum([
  'problem',
  'knowledge',
  'quiz',
  'summary',
  'note_section_update',
  'learning_item_completion',
  'learning_item_relearn',
]);

export const DreamingProposal = z.object({
  id: z.string(),
  kind: DreamingProposalKind,
  payload: z.record(z.unknown()),
  reasoning: z.string(),
  status: z.enum(['pending', 'accepted', 'dismissed']).default('pending'),
  proposed_at: z.coerce.date(),
  decided_at: z.coerce.date().nullish(),
});
export type DreamingProposal = z.infer<typeof DreamingProposal>;

// ---------- 观测 ----------

export const ToolCallLog = z.object({
  id: z.string(),
  task_run_id: z.string(),
  task_kind: z.string(),
  tool_name: z.string(),
  input_json: z.unknown(),
  output_json: z.unknown(),
  iteration: z.number().int(),
  latency_ms: z.number(),
  cost: z.number(),
  occurred_at: z.coerce.date(),
});
export type ToolCallLog = z.infer<typeof ToolCallLog>;

export const CostLedger = z.object({
  id: z.string(),
  task_kind: z.string(),
  provider: z.string(),
  model: z.string(),
  cost: z.number(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  occurred_at: z.coerce.date(),
});
export type CostLedger = z.infer<typeof CostLedger>;
