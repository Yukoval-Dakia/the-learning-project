import { boolean, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

// Drizzle schema (Postgres) — single source of truth.
// Per architecture-review.md § Stack Pivot: Postgres types throughout;
// json columns are jsonb; booleans + timestamps native.

export const knowledge = pgTable('knowledge', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  parent_id: text('parent_id'),
  base_mastery: real('base_mastery').notNull().default(0),
  ai_delta_mastery: real('ai_delta_mastery').notNull().default(0),
  last_active_at: timestamp('last_active_at', { withTimezone: true }),
  merged_from: jsonb('merged_from').$type<string[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
  approval_status: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('approved'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const source_asset = pgTable('source_asset', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  storage_key: text('storage_key').notNull(),
  mime_type: text('mime_type').notNull(),
  byte_size: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  provenance: jsonb('provenance').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const source_document = pgTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  body_md: text('body_md'),
  provenance: jsonb('provenance').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const ingestion_session = pgTable('ingestion_session', {
  id: text('id').primaryKey(),
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('uploaded'),
  entrypoint: text('entrypoint').notNull(),
  error_message: text('error_message'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question_block = pgTable('question_block', {
  id: text('id').primaryKey(),
  ingestion_session_id: text('ingestion_session_id').notNull(),
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  page_spans: jsonb('page_spans')
    .$type<
      Array<{
        page_index: number;
        bbox: { x: number; y: number; width: number; height: number };
        role?: string;
      }>
    >()
    .notNull()
    .default([]),
  extracted_prompt_md: text('extracted_prompt_md').notNull(),
  reference_md: text('reference_md'),
  wrong_answer_md: text('wrong_answer_md'),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  crop_refs: jsonb('crop_refs').$type<string[]>().notNull().default([]),
  visual_complexity: text('visual_complexity').notNull().default('low'),
  extraction_confidence: real('extraction_confidence').notNull().default(1),
  status: text('status').notNull().default('draft'),
  knowledge_hint: text('knowledge_hint'),
  merged_from_block_ids: jsonb('merged_from_block_ids').$type<string[]>().notNull().default([]),
  imported_question_id: text('imported_question_id'),
  imported_mistake_id: text('imported_mistake_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question = pgTable('question', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  prompt_md: text('prompt_md').notNull(),
  reference_md: text('reference_md'),
  rubric_json: jsonb('rubric_json'),
  judge_kind_override: text('judge_kind_override'),
  visual_complexity: text('visual_complexity'),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  difficulty: integer('difficulty').notNull().default(3),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  draft_status: text('draft_status'),
  variant_depth: integer('variant_depth').notNull().default(0),
  root_question_id: text('root_question_id'),
  parent_variant_id: text('parent_variant_id'),
  created_by: jsonb('created_by'),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const mistake = pgTable('mistake', {
  id: text('id').primaryKey(),
  question_id: text('question_id')
    .notNull()
    .references(() => question.id),
  wrong_answer_md: text('wrong_answer_md'),
  wrong_answer_image_refs: jsonb('wrong_answer_image_refs').$type<string[]>().notNull().default([]),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  cause: jsonb('cause'),
  fsrs_state: jsonb('fsrs_state'),
  variants: jsonb('variants').$type<unknown[]>().notNull().default([]),
  variants_generated_count: integer('variants_generated_count').notNull().default(0),
  variants_max: integer('variants_max').notNull().default(3),
  status: text('status').notNull().default('active'),
  archived_reason: text('archived_reason'),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  delete_reason: text('delete_reason'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const review_event = pgTable('review_event', {
  id: text('id').primaryKey(),
  mistake_id: text('mistake_id').notNull(),
  rating: text('rating').notNull(),
  response_md: text('response_md'),
  latency_ms: integer('latency_ms'),
  fsrs_state_before: jsonb('fsrs_state_before'),
  fsrs_state_after: jsonb('fsrs_state_after').notNull(),
  due_at_before: timestamp('due_at_before', { withTimezone: true }),
  due_at_next: timestamp('due_at_next', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const learning_item = pgTable('learning_item', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  primary_artifact_id: text('primary_artifact_id'),
  parent_learning_item_id: text('parent_learning_item_id'),
  child_learning_item_ids: jsonb('child_learning_item_ids').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('pending'),
  user_pinned: boolean('user_pinned').notNull().default(false),
  ai_score: real('ai_score'),
  due_at: timestamp('due_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  archived_reason: text('archived_reason'),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const study_log = pgTable('study_log', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content_md: text('content_md').notNull(),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  question_id: text('question_id'),
  mistake_id: text('mistake_id'),
  artifact_id: text('artifact_id'),
  learning_item_id: text('learning_item_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const artifact = pgTable('artifact', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  knowledge_id: text('knowledge_id'),
  parent_artifact_id: text('parent_artifact_id'),
  child_artifact_ids: jsonb('child_artifact_ids').$type<string[]>().notNull().default([]),
  intent_source: text('intent_source').notNull(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  outline_json: jsonb('outline_json'),
  sections: jsonb('sections'),
  tool_kind: text('tool_kind'),
  tool_state: jsonb('tool_state'),
  generation_status: text('generation_status').notNull().default('pending'),
  generated_by: jsonb('generated_by'),
  history: jsonb('history').$type<unknown[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const answer = pgTable('answer', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  learning_item_id: text('learning_item_id'),
  input_kind: text('input_kind').notNull(),
  content_md: text('content_md').notNull().default(''),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  vision_extracted: text('vision_extracted'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  submitted_at: timestamp('submitted_at', { withTimezone: true }).notNull(),
});

export const judgment = pgTable('judgment', {
  id: text('id').primaryKey(),
  answer_id: text('answer_id').notNull(),
  judge_kind: text('judge_kind').notNull(),
  verdict: text('verdict').notNull(),
  score: real('score').notNull(),
  feedback_md: text('feedback_md').notNull(),
  evidence_json: jsonb('evidence_json').notNull().default({}),
  is_flexible_fallback: boolean('is_flexible_fallback').notNull().default(false),
  triggered_by: text('triggered_by'),
  prior_judgment_id: text('prior_judgment_id'),
  judged_by: jsonb('judged_by').notNull(),
  judged_at: timestamp('judged_at', { withTimezone: true }).notNull(),
  is_effective: boolean('is_effective').notNull().default(true),
});

export const user_appeal = pgTable('user_appeal', {
  id: text('id').primaryKey(),
  judgment_id: text('judgment_id').notNull(),
  reason: text('reason'),
  appealed_at: timestamp('appealed_at', { withTimezone: true }).notNull(),
  resolved_judgment_id: text('resolved_judgment_id'),
});

export const completion_evidence = pgTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: jsonb('evidence_json').notNull().default({}),
  user_overrode_low_evidence: boolean('user_overrode_low_evidence').notNull().default(false),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
});

export const dreaming_proposal = pgTable('dreaming_proposal', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  reasoning: text('reasoning').notNull(),
  status: text('status').notNull().default('pending'),
  proposed_at: timestamp('proposed_at', { withTimezone: true }).notNull(),
  decided_at: timestamp('decided_at', { withTimezone: true }),
});

export const tool_call_log = pgTable('tool_call_log', {
  id: text('id').primaryKey(),
  task_run_id: text('task_run_id').notNull(),
  task_kind: text('task_kind').notNull(),
  tool_name: text('tool_name').notNull(),
  input_json: jsonb('input_json'),
  output_json: jsonb('output_json'),
  iteration: integer('iteration').notNull(),
  latency_ms: real('latency_ms').notNull(),
  cost: real('cost').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

export const cost_ledger = pgTable('cost_ledger', {
  id: text('id').primaryKey(),
  task_kind: text('task_kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  cost: real('cost').notNull(),
  tokens_in: integer('tokens_in').notNull(),
  tokens_out: integer('tokens_out').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
});
