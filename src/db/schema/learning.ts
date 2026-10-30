// Learning sessions and records: learning items/records, sessions, ingestion
// creation receipts, answers, completion evidence, and the practice stream.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

type JsonObject = Record<string, unknown>;

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
    // ADR-0027 (YUK-203 P1) — the YUK-171 1:1 uniqueIndex on primary_artifact_id was
    // dropped: a note(artifact) is now a first-class knowledge-labeled entity and a
    // learning_item only *references* it. primary_artifact_id stays as a nullable
    // "primary/representative" pointer (no longer DB-unique; one artifact may be the
    // primary of more than one item). A plain index is kept for owner-lookup reads.
    // See docs/adr/0027-note-artifact-decouple-from-learning-item-ownership.md.
    index('learning_item_primary_artifact_idx').on(t.primary_artifact_id),
    // YUK-733: indexes the `knowledge_ids @> '["<kc>"]'::jsonb` containment read on the
    // user-facing note page related-items query (note-page.ts) + KC-merge rewrites.
    // jsonb_path_ops supports @> and is smaller/faster than the default jsonb_ops.
    index('learning_item_knowledge_ids_gin').using('gin', sql`${t.knowledge_ids} jsonb_path_ops`),
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
    // YUK-543 — CONTRACT: never rewritten on a KC merge (applyMerge deliberately excludes this
    // column). learning_record is the append-only ATOMIC evidence layer — the un-aggregated
    // observation unit a future unmergeKnowledge() must re-fit new per-KC parameters FROM (the
    // Sentry-fingerprint analogy: unmerge is only possible because the atomic keys were never
    // rewritten by the merge). Any "顺手清理" that pulls this column into a rewrite pass destroys
    // that feasibility precondition. See the YUK-543 spec D-D verdict (Appendix C).
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
    // YUK-733: indexes the `knowledge_ids @> '["<kc>"]'::jsonb` containment read on the
    // query_records AI tool + listLearningRecords over this append-only, never-pruned
    // evidence log. jsonb_path_ops supports @> and is smaller/faster than jsonb_ops.
    index('learning_record_knowledge_ids_gin').using('gin', sql`${t.knowledge_ids} jsonb_path_ops`),
  ],
);

// U5 (YUK-203) — `answer` revived as the paper answer-sheet draft layer
// (ADR-0029 决定 #3: 既有原语复用, NOT a new table — RL2). Link columns are
// loose-coupled plain text refs (no FK — matches event.task_run_id /
// learning_record.artifact_id precedent, Q4 ruling): orphan-cleanup cron and
// artifact soft-delete must not be blocked by an FK.
//
// Draft grain is PER-SLOT `(session_id, question_id, part_ref)` (Q5): a
// composite question with parts gets one row per part; atomic questions have
// part_ref=null. The autosave partial unique index (drizzle/0028, hand-written)
// guarantees ONE live draft per slot. submitted_at is now nullable: null=live
// draft, set=frozen. Frozen rows are append-only history — re-submission (after
// abandon→reopen) writes a NEW row and never mutates a frozen one (§4.5).
//
// learning_item_id stays nullable/unused for paper answers (DEFER per Map §B3).
export const answer = pgTable('answer', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  learning_item_id: text('learning_item_id'),
  input_kind: text('input_kind').notNull(),
  content_md: text('content_md').notNull().default(''),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  vision_extracted: text('vision_extracted'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  // U5 — null = live draft, set = frozen at submit. DROP NOT NULL in 0028.
  submitted_at: timestamp('submitted_at', { withTimezone: true }),
  // U5 link columns (loose refs, no FK):
  session_id: text('session_id'),
  paper_artifact_id: text('paper_artifact_id'),
  // StructuredQuestion.id of the part this answer targets; null for atomic Qs.
  part_ref: text('part_ref'),
  // back-ref to the attempt/review event written at freeze
  event_id: text('event_id'),
  // mutable working-state stamp on each autosave
  autosaved_at: timestamp('autosaved_at', { withTimezone: true }),
});

// U5 — the autosave partial unique index `answer_draft_slot_uk`
// (session_id, question_id, COALESCE(part_ref,'')) WHERE submitted_at IS NULL
// is declared in the hand-written migration drizzle/0028_u5_paper_answer_links.sql
// (drizzle-kit doesn't emit partial-index WHERE / COALESCE expression-indexes at
// this version — same pattern as the event outbox index, see above). Not in the
// table-def index array so db:generate doesn't try to re-emit it incompletely.

// Phase 1c.1 Step 1.4 (Lane A): judgment + user_appeal tables DROPped per
// data-assumptions §O2. judging is now an event (action='judge',
// subject_kind='event') per ADR-0006 v2.

export const completion_evidence = pgTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: jsonb('evidence_json').$type<JsonObject>().notNull().default({}),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
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
  // YUK-1522 (LIGHT 启动额度门) — ingestion-agent 周预算授权台账。jsonb 包络
  // `{week_tz, grants, operations, attributions, tasks, historical_ocr}`：Grant 记录本次启动的授权
  // 身份（in_flight | awaiting_cost | settled）、授权时读到的 system_config revision、
  // limit/used 回执、周起点 instant。DURABLE 启动身份不能落在 30 天 TTL 的
  // job_events 上，故挂本行随 session 备份（additive 列 → 整行 dump/restore，
  // 不 bump SCHEMA_VERSION）。reservation 无付费授权，拒绝记录也永久保存。
  // Write path = ingestion/server/agent/budget-state.ts 的路径级写入；
  // operation-identity.ts / agent/{budget,spend}.ts 分别持有身份/授权/费用职责。
  agent_budget: jsonb('agent_budget'),
  // conversation-only fields
  summary_md: text('summary_md'),
  // YUK-936 — Agent SDK session id for foreground inline Copilot resume (ADR-0054).
  // Product session_id stays learning_session.id; this is server-owned SDK transcript
  // continuity. NULL when cold-starting or after resume-fail clear. Write path =
  // copilot/server/copilot-run-session-cursor.ts: set/clearAgentSdkSessionId.
  agent_sdk_session_id: text('agent_sdk_session_id'),
  // goal linkage — Phase 1d placeholder
  goal_id: text('goal_id'),
  // U5 (YUK-203) — soft reference to the paper artifact a review-attempt session
  // is taking (Q4: loose coupling, NO FK — matches event.task_run_id; a deleted
  // paper artifact must not block session rows / the orphan-cleanup cron). Null
  // for FSRS-逐张 review, conversation, and tutor sessions. Write path =
  // startReviewSession({ artifactId }) binding (RL4: write path same PR → no
  // allowlist entry).
  artifact_id: text('artifact_id'),
  // YUK-470/YUK-535 — server-owned KC scope. Placement captures the resolved goal-subgraph set;
  // KC-scoped review captures the single requested knowledge id. Both consumers read it
  // server-side instead of trusting repeated client bodies. NULL for unscoped review and every
  // other session type. Write paths = startPlacementSession({ knowledgeIds }) and
  // startReviewSession({ scopeKnowledgeIds }).
  // YUK-543 — DELIBERATELY LEFT STALE on a KC merge: applyMerge does NOT rewrite this column. It is
  // session-ephemeral — an in-flight placement probe holding a since-merged KC just returns an empty
  // pool for that id and silently skips it for the session's remaining duration. A declared, accepted
  // staleness (spec §2 table), not a silent gap; a new session resolves the survivor KC afresh.
  scope_knowledge_ids: jsonb('scope_knowledge_ids').$type<string[]>(),
  // YUK-480 — placement-only onboarding self-report transport. The learner's Welcome-screen
  // self-report (subject leanings + daily pace) is captured at probe start so it survives the
  // multi-call probe loop server-side (the /next route reads it under the same row lock as
  // scope_knowledge_ids, never trusting the client to re-send it). Both feed placement ORDERING
  // / amount ONLY — NEVER θ̂/p(L)/FSRS (§3 red line 4): `placement_leanings` PREFERS leaning-
  // subject questions in selection order (capForPace), `placement_pace` maps to the probe count
  // cap. Owner-supplied fixed inputs (n=1 admissible §0.2 cat 1/2). NULL for non-placement
  // sessions AND for placement probes started without a self-report (back-compat). Write path =
  // startPlacementSession({ leanings, pace }) in the same PR (RL4 → no allowlist). Additive
  // columns on an existing FK_ORDER table → ride whole-row dump/restore, NO SCHEMA_VERSION bump
  // (constants.ts「表 = bump，列 = 不 bump」).
  placement_leanings: jsonb('placement_leanings').$type<string[]>(),
  placement_pace: text('placement_pace'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(0),
});

// Long-lived creation identity: INSERT-only, independent of resource deletion.
export const ingestion_creation_receipt = pgTable(
  'ingestion_creation_receipt',
  {
    actor_ref: text('actor_ref').notNull(),
    operation_scope: text('operation_scope', {
      enum: ['ingestion_session.create.v1', 'manual_mistake.create.v1'],
    }).notNull(),
    idempotency_key: text('idempotency_key').notNull(),
    input_version: integer('input_version').notNull(),
    input_digest: text('input_digest').notNull(),
    response_status: integer('response_status').notNull(),
    response_body: jsonb('response_body').$type<unknown>().notNull(),
    response_location: text('response_location').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.actor_ref, table.operation_scope, table.idempotency_key] }),
    check('ingestion_creation_receipt_actor_check', sql`${table.actor_ref} = 'self'`),
    check(
      'ingestion_creation_receipt_scope_check',
      sql`${table.operation_scope} IN ('ingestion_session.create.v1', 'manual_mistake.create.v1')`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// M2 练习流（YUK-316，总 spec REV 2 §4-M2 / P2 spec §2.1）。
//
// 「AI 维护的日程」载体：流要支持白天动态插拔（点播插入、composer_live 增补、
// 做完推进），且用户中途离开回来流必须还在原状——所以物化而非纯派生。与事件
// 不变量不冲突：**作答事实仍只写 event**，stream_item 只是日程行；status 由
// 作答动作驱动推进（前端 submit 成功后 PATCH）。
// ─────────────────────────────────────────────────────────────────────────────

export const practice_stream_item = pgTable(
  'practice_stream_item',
  {
    id: text('id').primaryKey(),
    // 流按天组织（YYYY-MM-DD；本地日由 API 层裁定后落库）
    date: text('date').notNull(),
    // YUK-535 — NULL = 既有整档案日流；非 NULL = 独立的按需 review session。
    // 软引用 learning_session.id（与 artifact_id/event.task_run_id 同项目惯例，不设 FK）：
    // scoped session 的题项必须与日流物理隔离，避免一个 `?kc=` 请求使日流的 lazy-compose
    // 误判「今天已编排」，也避免专项完成/跳过状态污染整档案日流。
    session_id: text('session_id'),
    position: integer('position').notNull(),
    item_kind: text('item_kind').$type<'question' | 'paper'>().notNull(),
    // question.id 或 paper artifact id（软引用，沿用项目惯例）
    ref_id: text('ref_id').notNull(),
    source: text('source')
      // B3 (YUK-349 #3) — 'frontier' added: TYPE-ONLY widen of this free-text column
      // (no DB enum, no migration). practice_stream_item.source is plain `text`.
      .$type<
        | 'decay'
        | 'variant'
        | 'new_check'
        | 'paper'
        | 'on_demand'
        | 'import'
        | 'frontier'
        | 'intervention'
      >()
      .notNull(),
    status: text('status')
      .$type<'pending' | 'in_progress' | 'done' | 'skipped'>()
      .notNull()
      .default('pending'),
    // AI 排入理由（第一人称 provenance 素材）。M2 为模板生成；M4 夜链 AI 化。
    reasoning: text('reasoning').notNull(),
    added_by: text('added_by')
      .$type<'composer_nightly' | 'composer_live' | 'copilot' | 'user'>()
      .notNull(),
    // YUK-361 Phase 1（观测先行）— 该项排入时的选题信号快照（MFI / θ̂ /
    // theta_precision / π_i / 三个 #52 信号字段……，见 src/core/selection-signals.ts
    // SelectionCandidateSignal）。**零行为变更**：本 lane 不改 composeDailyStream
    // 排序，default {} 让既有 stream composer 测试零回归；值由 Phase 3 候选收集层
    // 计算后填充。
    signals: jsonb('signals').$type<JsonObject>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('practice_stream_date_idx').on(t.date, t.position),
    index('practice_stream_session_idx').on(t.session_id, t.position),
    // 日流同日同 ref 不重复；session 流则在 session 内同 ref 不重复。partial unique 明确
    // 分开两个 partition，使同一道题可以在日流与专项 session 各有独立进度。
    uniqueIndex('practice_stream_daily_ref_unique')
      .on(t.date, t.ref_id)
      .where(sql`${t.session_id} IS NULL`),
    uniqueIndex('practice_stream_session_ref_unique')
      .on(t.session_id, t.ref_id)
      .where(sql`${t.session_id} IS NOT NULL`),
  ],
);
