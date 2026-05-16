import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type {
  AgentRef,
  ArtifactHistoryEntry,
  Cause,
  FsrsState,
  MistakeVariant,
  NoteSection,
  Provenance,
  Rubric,
  ToolState,
} from '../core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '../core/schema/structured_question';

// Drizzle schema (Postgres) — single source of truth.
// Per architecture-review.md § Stack Pivot: Postgres types throughout;
// json columns are jsonb; booleans + timestamps native.
//
// JSON column types come from src/core/schema/business.ts. Importing the
// inferred types (not the schemas) keeps this module zod-free at runtime;
// generated.ts wraps these tables with drizzle-zod for validation.

type AgentRefT = z.infer<typeof AgentRef>;
type ArtifactHistoryEntryT = z.infer<typeof ArtifactHistoryEntry>;
type CauseT = z.infer<typeof Cause>;
type FsrsStateT = z.infer<typeof FsrsState>;
type MistakeVariantT = z.infer<typeof MistakeVariant>;
type NoteSectionT = z.infer<typeof NoteSection>;
type ProvenanceT = z.infer<typeof Provenance>;
type RubricT = z.infer<typeof Rubric>;
type ToolStateT = z.infer<typeof ToolState>;

type JsonObject = Record<string, unknown>;

export const knowledge = pgTable(
  'knowledge',
  {
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
  },
  (t) => [
    check('knowledge_base_mastery_range', sql`${t.base_mastery} BETWEEN 0 AND 1`),
    // AI can move mastery at most ±0.2 from the base value (per ADR: hybrid mastery).
    check('knowledge_ai_delta_mastery_range', sql`${t.ai_delta_mastery} BETWEEN -0.2 AND 0.2`),
  ],
);

export const source_asset = pgTable('source_asset', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  storage_key: text('storage_key').notNull(),
  mime_type: text('mime_type').notNull(),
  byte_size: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  provenance: jsonb('provenance').$type<ProvenanceT>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const source_document = pgTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  body_md: text('body_md'),
  provenance: jsonb('provenance').$type<ProvenanceT>().notNull().default({}),
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
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question_block = pgTable(
  'question_block',
  {
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
    // 2026-05-14: deviation from plan Step 0.4 —— plan 原文要求 DROP COLUMN，但
    // 当前 cascade.ts / ingestion route / import route 仍写此列，若现在 DROP 则
    // typecheck + 测试在 Step 1-10 之间全断。改为 nullable（行为：新代码不写、
    // 老代码继续写），DROP 推迟到 Step 11.5 legacy route 迁完之后。
    extracted_prompt_md: text('extracted_prompt_md'),
    // structured 是 Tencent Mark Agent 返回的递归 StructuredQuestion 树
    structured: jsonb('structured').$type<StructuredQuestionT>(),
    // figures: 题目附带的图（FigureRef[]）
    figures: jsonb('figures').$type<FigureRefT[]>().notNull().default([]),
    layout_quality: text('layout_quality').notNull().default('structured'),
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
  },
  (t) => [
    check(
      'question_block_extraction_confidence_range',
      sql`${t.extraction_confidence} BETWEEN 0 AND 1`,
    ),
  ],
);

export const question = pgTable(
  'question',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    prompt_md: text('prompt_md').notNull(),
    reference_md: text('reference_md'),
    rubric_json: jsonb('rubric_json').$type<RubricT>(),
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
    created_by: jsonb('created_by').$type<AgentRefT>(),
    metadata: jsonb('metadata').$type<JsonObject>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [check('question_difficulty_range', sql`${t.difficulty} BETWEEN 1 AND 5`)],
);

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
  cause: jsonb('cause').$type<CauseT>(),
  fsrs_state: jsonb('fsrs_state').$type<FsrsStateT>(),
  variants: jsonb('variants').$type<MistakeVariantT[]>().notNull().default([]),
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
  fsrs_state_before: jsonb('fsrs_state_before').$type<FsrsStateT>(),
  fsrs_state_after: jsonb('fsrs_state_after').$type<FsrsStateT>().notNull(),
  due_at_before: timestamp('due_at_before', { withTimezone: true }),
  due_at_next: timestamp('due_at_next', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const learning_item = pgTable(
  'learning_item',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    source_ref: text('source_ref'),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    primary_artifact_id: text('primary_artifact_id'),
    parent_learning_item_id: text('parent_learning_item_id'),
    child_learning_item_ids: jsonb('child_learning_item_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
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
  },
  (t) => [
    // ai_score is nullable; CHECK accepts NULL by default.
    check('learning_item_ai_score_range', sql`${t.ai_score} BETWEEN 0 AND 1`),
  ],
);

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

// 激活 — C 档 AI 主动产出落点（per ADR-0006 v2 / Phase 1c.1）。
// Phase 1c.1 brainstorm（2026-05-14 → ADR-0006 v2）拍板保留：作为 Note / 长答案 /
// 工具产物等 AI 主动产出的统一落地表。当前仍零写入路径——Phase 1c.1 Step 9 落地
// AI 产出 handler 时启用（NoteGenerateTask / BlockAssemblyTask 等）。
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
  outline_json: jsonb('outline_json').$type<JsonObject>(),
  sections: jsonb('sections').$type<NoteSectionT[]>(),
  tool_kind: text('tool_kind'),
  tool_state: jsonb('tool_state').$type<ToolStateT>(),
  generation_status: text('generation_status').notNull().default('pending'),
  generated_by: jsonb('generated_by').$type<AgentRefT>(),
  history: jsonb('history').$type<ArtifactHistoryEntryT[]>().notNull().default([]),
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

export const judgment = pgTable(
  'judgment',
  {
    id: text('id').primaryKey(),
    answer_id: text('answer_id').notNull(),
    judge_kind: text('judge_kind').notNull(),
    verdict: text('verdict').notNull(),
    score: real('score').notNull(),
    feedback_md: text('feedback_md').notNull(),
    evidence_json: jsonb('evidence_json').$type<JsonObject>().notNull().default({}),
    is_flexible_fallback: boolean('is_flexible_fallback').notNull().default(false),
    triggered_by: text('triggered_by'),
    prior_judgment_id: text('prior_judgment_id'),
    judged_by: jsonb('judged_by').$type<AgentRefT>().notNull(),
    judged_at: timestamp('judged_at', { withTimezone: true }).notNull(),
    is_effective: boolean('is_effective').notNull().default(true),
  },
  (t) => [check('judgment_score_range', sql`${t.score} BETWEEN 0 AND 1`)],
);

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
  evidence_json: jsonb('evidence_json').$type<JsonObject>().notNull().default({}),
  user_overrode_low_evidence: boolean('user_overrode_low_evidence').notNull().default(false),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
});

export const dreaming_proposal = pgTable('dreaming_proposal', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<JsonObject>().notNull(),
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
  input_json: jsonb('input_json').$type<JsonObject>(),
  output_json: jsonb('output_json').$type<JsonObject>(),
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
  outcome: text('outcome').notNull().default('success'),
  pgboss_job_id: text('pgboss_job_id'),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

// pg-boss 之上的"业务事件流"：每次状态迁移同事务 INSERT 一行 + pg_notify。
// SSE replay 根据 (business_table, business_id, id) 索引查 since-id 增量事件。
// 见 ADR-0005 / 0008 + Sub 0c plan Step 3
export const job_events = pgTable(
  'job_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    business_table: text('business_table').notNull(),
    business_id: text('business_id').notNull(),
    event_type: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // computeReplay 主查询路径：(table, id, id > lastEventId ORDER BY id ASC)
    index('job_events_business_idx').on(t.business_table, t.business_id, t.id),
  ],
);

// Echo job 用作 Sub 0c golden E2E（acceptance gate #1）：HTTP enqueue → pg-boss
// worker → DB update → SSE delivers full-state event。Step 4 实现
export const echo_jobs = pgTable('echo_jobs', {
  id: text('id').primaryKey(),
  input: text('input').notNull(),
  output: text('output'),
  status: text('status').notNull().default('queued'),
  error_md: text('error_md'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});
