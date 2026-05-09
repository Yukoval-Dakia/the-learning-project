import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Drizzle schema —— 单一来源；Zod 部分由 drizzle-zod 在 src/core/schema/generated.ts 自动生成。
// JSON 字段以 TEXT 存（drizzle 的 mode:'json' 自动序列化）。
// 时间戳全部以 unix-second integer 存。

export const knowledge = sqliteTable('knowledge', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  parent_id: text('parent_id'),
  base_mastery: real('base_mastery').notNull().default(0),
  ai_delta_mastery: real('ai_delta_mastery').notNull().default(0),
  last_active_at: integer('last_active_at', { mode: 'timestamp' }),
  merged_from: text('merged_from', { mode: 'json' }).$type<string[]>().notNull().default([]),
  archived_at: integer('archived_at', { mode: 'timestamp' }),
  proposed_by_ai: integer('proposed_by_ai', { mode: 'boolean' }).notNull().default(false),
  approval_status: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('approved'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question = sqliteTable('question', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  prompt_md: text('prompt_md').notNull(),
  reference_md: text('reference_md'),
  rubric_json: text('rubric_json', { mode: 'json' }),
  judge_kind_override: text('judge_kind_override'),
  visual_complexity: text('visual_complexity'),
  knowledge_ids: text('knowledge_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  difficulty: integer('difficulty').notNull().default(3),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  draft_status: text('draft_status'),
  variant_depth: integer('variant_depth').notNull().default(0),
  root_question_id: text('root_question_id'),
  parent_variant_id: text('parent_variant_id'),
  created_by: text('created_by', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const mistake = sqliteTable('mistake', {
  id: text('id').primaryKey(),
  question_id: text('question_id')
    .notNull()
    .references(() => question.id),
  wrong_answer_md: text('wrong_answer_md'),
  wrong_answer_image_refs: text('wrong_answer_image_refs', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  knowledge_ids: text('knowledge_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  cause: text('cause', { mode: 'json' }),
  fsrs_state: text('fsrs_state', { mode: 'json' }),
  variants: text('variants', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  variants_generated_count: integer('variants_generated_count').notNull().default(0),
  variants_max: integer('variants_max').notNull().default(3),
  status: text('status').notNull().default('active'),
  archived_reason: text('archived_reason'),
  archived_at: integer('archived_at', { mode: 'timestamp' }),
  deleted_at: integer('deleted_at', { mode: 'timestamp' }),
  delete_reason: text('delete_reason'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const learning_item = sqliteTable('learning_item', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  knowledge_ids: text('knowledge_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  primary_artifact_id: text('primary_artifact_id'),
  parent_learning_item_id: text('parent_learning_item_id'),
  child_learning_item_ids: text('child_learning_item_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  status: text('status').notNull().default('pending'),
  user_pinned: integer('user_pinned', { mode: 'boolean' }).notNull().default(false),
  ai_score: real('ai_score'),
  due_at: integer('due_at', { mode: 'timestamp' }),
  completed_at: integer('completed_at', { mode: 'timestamp' }),
  dismissed_at: integer('dismissed_at', { mode: 'timestamp' }),
  archived_at: integer('archived_at', { mode: 'timestamp' }),
  archived_reason: text('archived_reason'),
  reviewed_at: integer('reviewed_at', { mode: 'timestamp' }),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const study_log = sqliteTable('study_log', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content_md: text('content_md').notNull(),
  knowledge_ids: text('knowledge_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  question_id: text('question_id'),
  mistake_id: text('mistake_id'),
  artifact_id: text('artifact_id'),
  learning_item_id: text('learning_item_id'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const artifact = sqliteTable('artifact', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  knowledge_id: text('knowledge_id'),
  parent_artifact_id: text('parent_artifact_id'),
  child_artifact_ids: text('child_artifact_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  intent_source: text('intent_source').notNull(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  outline_json: text('outline_json', { mode: 'json' }),
  sections: text('sections', { mode: 'json' }),
  tool_kind: text('tool_kind'),
  tool_state: text('tool_state', { mode: 'json' }),
  generation_status: text('generation_status').notNull().default('pending'),
  generated_by: text('generated_by', { mode: 'json' }),
  history: text('history', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  archived_at: integer('archived_at', { mode: 'timestamp' }),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const answer = sqliteTable('answer', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  learning_item_id: text('learning_item_id'),
  input_kind: text('input_kind').notNull(),
  content_md: text('content_md').notNull().default(''),
  image_refs: text('image_refs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  vision_extracted: text('vision_extracted'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  submitted_at: integer('submitted_at', { mode: 'timestamp' }).notNull(),
});

export const judgment = sqliteTable('judgment', {
  id: text('id').primaryKey(),
  answer_id: text('answer_id').notNull(),
  judge_kind: text('judge_kind').notNull(),
  verdict: text('verdict').notNull(),
  score: real('score').notNull(),
  feedback_md: text('feedback_md').notNull(),
  evidence_json: text('evidence_json', { mode: 'json' }).notNull().default({}),
  is_flexible_fallback: integer('is_flexible_fallback', { mode: 'boolean' })
    .notNull()
    .default(false),
  triggered_by: text('triggered_by'),
  prior_judgment_id: text('prior_judgment_id'),
  judged_by: text('judged_by', { mode: 'json' }).notNull(),
  judged_at: integer('judged_at', { mode: 'timestamp' }).notNull(),
  is_effective: integer('is_effective', { mode: 'boolean' }).notNull().default(true),
});

export const user_appeal = sqliteTable('user_appeal', {
  id: text('id').primaryKey(),
  judgment_id: text('judgment_id').notNull(),
  reason: text('reason'),
  appealed_at: integer('appealed_at', { mode: 'timestamp' }).notNull(),
  resolved_judgment_id: text('resolved_judgment_id'),
});

export const completion_evidence = sqliteTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: text('evidence_json', { mode: 'json' }).notNull().default({}),
  user_overrode_low_evidence: integer('user_overrode_low_evidence', { mode: 'boolean' })
    .notNull()
    .default(false),
  decided_at: integer('decided_at', { mode: 'timestamp' }).notNull(),
});

export const dreaming_proposal = sqliteTable('dreaming_proposal', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  reasoning: text('reasoning').notNull(),
  status: text('status').notNull().default('pending'),
  proposed_at: integer('proposed_at', { mode: 'timestamp' }).notNull(),
  decided_at: integer('decided_at', { mode: 'timestamp' }),
});

export const tool_call_log = sqliteTable('tool_call_log', {
  id: text('id').primaryKey(),
  task_run_id: text('task_run_id').notNull(),
  task_kind: text('task_kind').notNull(),
  tool_name: text('tool_name').notNull(),
  input_json: text('input_json', { mode: 'json' }),
  output_json: text('output_json', { mode: 'json' }),
  iteration: integer('iteration').notNull(),
  latency_ms: real('latency_ms').notNull(),
  cost: real('cost').notNull(),
  occurred_at: integer('occurred_at', { mode: 'timestamp' }).notNull(),
});

export const cost_ledger = sqliteTable('cost_ledger', {
  id: text('id').primaryKey(),
  task_kind: text('task_kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  cost: real('cost').notNull(),
  tokens_in: integer('tokens_in').notNull(),
  tokens_out: integer('tokens_out').notNull(),
  occurred_at: integer('occurred_at', { mode: 'timestamp' }).notNull(),
});
