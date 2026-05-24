import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type {
  AgentRef,
  ArtifactHistoryEntry,
  FsrsState,
  NoteSection,
  NoteVerificationResult,
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
type FsrsStateT = z.infer<typeof FsrsState>;
type NoteSectionT = z.infer<typeof NoteSection>;
type NoteVerificationResultT = z.infer<typeof NoteVerificationResult>;
type ProvenanceT = z.infer<typeof Provenance>;
type RubricT = z.infer<typeof Rubric>;
type ToolStateT = z.infer<typeof ToolState>;

type JsonObject = Record<string, unknown>;

// Phase 1c.1 Step 1.2 (Lane A): DROPped base_mastery / ai_delta_mastery / last_active_at
// per ADR-0012 — mastery is now a derived PG view (knowledge_mastery, declared below).
export const knowledge = pgTable('knowledge', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  parent_id: text('parent_id'),
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

// Phase 1c.1 Step 9.J — `ingestion_session` table DROPped. Sessions now live
// in `learning_session(type='ingestion')` (ADR-0008). The `question_block.
// ingestion_session_id` text column is preserved (no FK enforced; points at
// learning_session.id post-migration).

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
    imported_attempt_event_id: text('imported_attempt_event_id'),
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
    choices_md: jsonb('choices_md').$type<string[]>(),
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
    // M-1 (2026-05-21): first-class multimodal carriers.
    // `metadata.prompt_image_refs` is the legacy simple-image-ref path (still
    // written by ingestion for backwards-compatible readers; new code SHOULD
    // read from `image_refs` instead). See docs/superpowers/specs/2026-05-21-
    // math-mvp-vision-design.md §4 + docs/adr/0002 revision 2026-05-21.
    figures: jsonb('figures').$type<FigureRefT[]>().notNull().default([]),
    image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
    // `structured` is the recursive StructuredQuestion tree (stem/sub/standalone);
    // nullable for non-structured questions (variant_gen / embedded_check / etc).
    structured: jsonb('structured').$type<StructuredQuestionT | null>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [check('question_difficulty_range', sql`${t.difficulty} BETWEEN 1 AND 5`)],
);

// Phase 1c.1 Step 9.J — `mistake` and `review_event` tables DROPped per
// ADR-0006 v2: failure attempts are events (action='attempt', outcome='failure'),
// reviews are events (action='review'). FSRS state projection lives in
// `material_fsrs_state` declared below.

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

export const learning_record = pgTable(
  'learning_record',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title'),
    content_md: text('content_md').notNull().default(''),
    source: text('source').notNull(),
    capture_mode: text('capture_mode').notNull(),
    activity_kind: text('activity_kind').notNull(),
    processing_status: text('processing_status').notNull().default('raw'),
    origin_event_id: text('origin_event_id'),
    subject_id: text('subject_id'),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    question_id: text('question_id'),
    attempt_event_id: text('attempt_event_id'),
    learning_item_id: text('learning_item_id'),
    artifact_id: text('artifact_id'),
    source_document_id: text('source_document_id'),
    asset_refs: jsonb('asset_refs').$type<string[]>().notNull().default([]),
    payload: jsonb('payload').$type<JsonObject>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('learning_record_kind_created_idx').on(t.kind, t.created_at.desc()),
    index('learning_record_question_idx').on(t.question_id),
    index('learning_record_attempt_idx').on(t.attempt_event_id),
    index('learning_record_origin_event_idx').on(t.origin_event_id),
  ],
);

export const memory_brief_note = pgTable(
  'memory_brief_note',
  {
    id: text('id').primaryKey(),
    scope_key: text('scope_key').notNull(),
    subject_id: text('subject_id'),
    recent_week_md: text('recent_week_md').notNull().default(''),
    recent_months_md: text('recent_months_md').notNull().default(''),
    long_term_md: text('long_term_md').notNull().default(''),
    recent_week_evidence_ids: jsonb('recent_week_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    recent_months_evidence_ids: jsonb('recent_months_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    long_term_evidence_ids: jsonb('long_term_evidence_ids').$type<string[]>().notNull().default([]),
    source_event_id: text('source_event_id'),
    refreshed_at: timestamp('refreshed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('memory_brief_note_scope_key_unique').on(t.scope_key)],
);

// 激活 — C 档 AI 主动产出落点（per ADR-0006 v2 + Phase 1c.1）。
// Phase 1c.1 brainstorm（2026-05-14 → ADR-0006 v2）拍板保留：作为 Note / 长答案 /
// 工具产物等 AI 主动产出的统一落地表。当前仍零写入路径——Phase 1c.2 落地
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
  verification_status: text('verification_status').notNull().default('not_required'),
  verification_summary: jsonb('verification_summary').$type<NoteVerificationResultT>(),
  generated_by: jsonb('generated_by').$type<AgentRefT>(),
  verified_by: jsonb('verified_by').$type<AgentRefT>(),
  embedded_check_status: text('embedded_check_status').notNull().default('not_required'),
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

// Phase 1c.1 Step 1.4 (Lane A): judgment + user_appeal tables DROPped per
// data-assumptions §O2. judging is now an event (action='judge',
// subject_kind='event') per ADR-0006 v2.

export const completion_evidence = pgTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: jsonb('evidence_json').$type<JsonObject>().notNull().default({}),
  user_overrode_low_evidence: boolean('user_overrode_low_evidence').notNull().default(false),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
});

// Phase 1c.1 Step 9.J — `dreaming_proposal` table DROPped. Proposals live as
// event(action='propose', subject_kind='knowledge') (Lane B ProposeKnowledge)
// plus experimental:knowledge_<mutation> namespace events.

export const ai_task_runs = pgTable(
  'ai_task_runs',
  {
    id: text('id').primaryKey(),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    input_hash: text('input_hash').notNull(),
    status: text('status').notNull().default('running'),
    finish_reason: text('finish_reason'),
    usage_json: jsonb('usage_json')
      .$type<{ inputTokens: number; outputTokens: number }>()
      .notNull()
      .default({ inputTokens: 0, outputTokens: 0 }),
    cost_usd: real('cost_usd'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_task_runs_task_kind_idx').on(t.task_kind, t.started_at.desc()),
    index('ai_task_runs_status_idx').on(t.status, t.started_at.desc()),
  ],
);

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

export const cost_ledger = pgTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    task_run_id: text('task_run_id'),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    cost: real('cost').notNull(),
    tokens_in: integer('tokens_in').notNull(),
    tokens_out: integer('tokens_out').notNull(),
    outcome: text('outcome').notNull().default('success'),
    pgboss_job_id: text('pgboss_job_id'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('cost_ledger_task_run_idx').on(t.task_run_id)],
);

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1c.1 Step 1.1 (Lane A) — event-driven core tables.
//
// Per ADR-0006 v2: events are the unified action log (user / agent / cron /
// system structurally equal). Per ADR-0008: learning_session is the polymorphic
// envelope for ingestion / review / tutor / explore / create / conversation
// sessions. Per ADR-0010: knowledge_edge carries typed mesh links between
// knowledge nodes (tree backbone + mesh muscle).
//
// `event.payload` is Zod-guarded per (action × subject_kind) discriminated
// union — written by Lane B (src/core/schema/event/**). Schema-level enforce-
// ment is intentionally absent; correctness lives in the Zod parse barrier.
// ─────────────────────────────────────────────────────────────────────────────

export const learning_session = pgTable('learning_session', {
  id: text('id').primaryKey(),
  // per-type semantics — Zod discriminated union in src/core/schema/learning_session.ts (Lane B)
  type: text('type').notNull(),
  // status machine per type — see Lane B schema
  status: text('status').notNull(),
  // ingestion-only fields (nullable for other types)
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  entrypoint: text('entrypoint'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  error_message: text('error_message'),
  // conversation-only fields
  summary_md: text('summary_md'),
  // goal linkage — Phase 1d placeholder
  goal_id: text('goal_id'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(0),
});

export const event = pgTable(
  'event',
  {
    id: text('id').primaryKey(),
    // nullable — cron / system events may have no session
    session_id: text('session_id'),
    // 'user' | 'agent' | 'cron' | 'system' (locked Lane B contract)
    actor_kind: text('actor_kind').notNull(),
    // 'self' (single user) | task_kind (agent) | cron_name | ...
    actor_ref: text('actor_ref').notNull(),
    // KnownEvent actions + 'experimental:*' namespace (locked Lane B contract)
    action: text('action').notNull(),
    // 'question' | 'knowledge' | 'knowledge_edge' | 'artifact' | 'source_document' |
    // 'event' | 'chip' | 'query' (locked Lane B contract)
    subject_kind: text('subject_kind').notNull(),
    subject_id: text('subject_id').notNull(),
    // 'success' | 'failure' | 'partial' | NULL (depends on action)
    outcome: text('outcome'),
    // Zod-guarded per (action × subject_kind) — see Lane B
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    // chain link: judge ← attempt, propose ← cron, etc.
    caused_by_event_id: text('caused_by_event_id'),
    // AI task run association
    task_run_id: text('task_run_id'),
    cost_micro_usd: integer('cost_micro_usd'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('event_subject_idx').on(t.subject_kind, t.subject_id, t.created_at.desc()),
    index('event_action_outcome_idx').on(t.action, t.outcome, t.created_at.desc()),
    index('event_session_idx').on(t.session_id, t.created_at),
    index('event_actor_idx').on(t.actor_kind, t.actor_ref, t.created_at),
    index('event_caused_by_idx').on(t.caused_by_event_id),
    // GIN index on payload (jsonb_path_ops) — declared in hand-written migration
    // (drizzle-kit doesn't generate GIN on jsonb_path_ops natively at this version).
    // See drizzle/0005_phase1c1_event_payload_gin.sql.
  ],
);

export const proposal_signals = pgTable(
  'proposal_signals',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    cooldown_key: text('cooldown_key').notNull(),
    accept_count: integer('accept_count').notNull().default(0),
    dismiss_count: integer('dismiss_count').notNull().default(0),
    acceptance_rate: real('acceptance_rate').notNull().default(0.5),
    dismiss_reason: text('dismiss_reason'),
    cooldown_until: timestamp('cooldown_until', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proposal_signals_key_unique').on(t.kind, t.cooldown_key),
    index('proposal_signals_kind_rate_idx').on(t.kind, t.acceptance_rate.desc()),
    index('proposal_signals_cooldown_idx').on(t.cooldown_key, t.cooldown_until),
  ],
);

// FSRS state projection per material (currently only 'question').
// Latest FSRS card state derived from `event(action='review', subject_kind='question')`.
export const material_fsrs_state = pgTable(
  'material_fsrs_state',
  {
    id: text('id').primaryKey(),
    // 'question' for Phase 1c.1; other material kinds in later phases
    subject_kind: text('subject_kind').notNull(),
    subject_id: text('subject_id').notNull(),
    // FsrsState (ts-fsrs Card-aligned) — typed via Lane B parse barrier
    state: jsonb('state').$type<FsrsStateT>().notNull(),
    due_at: timestamp('due_at', { withTimezone: true }).notNull(),
    last_review_event_id: text('last_review_event_id'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('material_fsrs_unique').on(t.subject_kind, t.subject_id),
    index('material_fsrs_due_idx').on(t.due_at),
  ],
);

// Typed mesh edges between knowledge nodes (ADR-0010).
// Tree (knowledge.parent_id) is the backbone; this is the muscle.
export const knowledge_edge = pgTable(
  'knowledge_edge',
  {
    id: text('id').primaryKey(),
    from_knowledge_id: text('from_knowledge_id')
      .notNull()
      .references(() => knowledge.id),
    to_knowledge_id: text('to_knowledge_id')
      .notNull()
      .references(() => knowledge.id),
    // 'prerequisite' | 'related_to' | 'contrasts_with' | 'applied_in' |
    // 'derived_from' | 'experimental:*' — Zod-validated in Lane B
    relation_type: text('relation_type').notNull(),
    // 0-1 confidence; AI proposals fill with confidence, user adds default 1
    weight: real('weight').notNull().default(1),
    created_by: jsonb('created_by').$type<AgentRefT>().notNull(),
    reasoning: text('reasoning'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('knowledge_edge_unique').on(
      t.from_knowledge_id,
      t.to_knowledge_id,
      t.relation_type,
    ),
    index('knowledge_edge_from_idx').on(t.from_knowledge_id, t.relation_type),
    index('knowledge_edge_to_idx').on(t.to_knowledge_id, t.relation_type),
  ],
);

// YUK-17 / ADR-0018 — variant lifecycle ledger.
//
// Each row tracks one AI-proposed mistake variant from "AI drafted" through
// "user accepted + question materialized" or "verify pass 2 broke it" / "user
// dismissed". variant_question proposals get a 'draft' row on write; accept
// transitions to 'active' (and the question row is materialized in the same
// txn); VariantVerifyTask second-pass verdict='fail' flips to 'broken'. See
// docs/adr/0018-mistake-variant-lifecycle-and-variants-max.md.
//
// counting variants_max = 3 reads the in-flight set (status IN ('draft',
// 'active')), so AI cannot flood the inbox even when the user defers review.
export const mistake_variant = pgTable(
  'mistake_variant',
  {
    id: text('id').primaryKey(),
    parent_question_id: text('parent_question_id').notNull(),
    variant_question_id: text('variant_question_id'),
    proposal_event_id: text('proposal_event_id'),
    status: text('status').notNull(),
    failure_reasons: jsonb('failure_reasons').$type<string[]>().notNull().default([]),
    cause_category: text('cause_category'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('mistake_variant_parent_idx').on(t.parent_question_id),
    index('mistake_variant_status_idx').on(t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1c.1 Step 1.3 (Lane A) — knowledge_mastery derived view.
//
// Per ADR-0012: mastery / last_active_at are derived from events, not stored
// fields. DDL lives in drizzle/0004_phase1c1_knowledge_mastery_view.sql
// (drizzle-kit can register the view as `.existing()` but does NOT generate
// the CREATE VIEW statement). All view columns nullable except knowledge_id
// (primary correlation) — `mastery` is NULL when no evidence, `evidence_count`
// is always 0+ via COALESCE in the view SQL, `last_active_at` defaults to
// knowledge.created_at when no events touch the node.
// ─────────────────────────────────────────────────────────────────────────────

export const knowledge_mastery = pgView('knowledge_mastery', {
  knowledge_id: text('knowledge_id').notNull(),
  mastery: real('mastery'),
  evidence_count: integer('evidence_count').notNull(),
  last_evidence_at: timestamp('last_evidence_at', { withTimezone: true }),
  last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull(),
}).existing();
