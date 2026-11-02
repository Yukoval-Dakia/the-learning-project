// Artifacts and notes: artifacts, verification claims, block refs, hub sync
// reconciliation, edit sessions, presence, and reconciliation logs.

import { sql } from 'drizzle-orm';
import {
  bigint,
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
  uuid,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type {
  AgentRef,
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  NoteVerificationResult,
  ToolState,
} from '../../core/schema/business';
import type { SerializedQueuedPatch } from '../../core/schema/note-refine-queue';

type AgentRefT = z.infer<typeof AgentRef>;
type ArtifactBodyBlocksT = z.infer<typeof ArtifactBodyBlocks>;
type ArtifactHistoryEntryT = z.infer<typeof ArtifactHistoryEntry>;
type NoteVerificationResultT = z.infer<typeof NoteVerificationResult>;
type ToolStateT = z.infer<typeof ToolState>;
type JsonObject = Record<string, unknown>;

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
    // P5.3 (YUK-183) — evidence-decay freshness score over long_term_evidence_ids
    // (SoT event.created_at). nullable; null = unjudgeable (no known backing
    // timestamps, knownCount === 0), distinct from a scored 0. Stays `real` (the
    // project float type for this render-only signal). NOTE: as of YUK-495 the
    // audit:schema parser also recognizes `doublePrecision` (scripts/audit-schema-writes.ts),
    // so that constructor is now a valid choice elsewhere. Render-annotation signal
    // only — no row mutation. Spec §5.
    long_term_freshness_score: real('long_term_freshness_score'),
    source_event_id: text('source_event_id'),
    latest_evidence_at: timestamp('latest_evidence_at', { withTimezone: true }),
    evidence_count: integer('evidence_count').notNull().default(0),
    refreshed_at: timestamp('refreshed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('memory_brief_note_scope_key_unique').on(t.scope_key)],
);

// 激活 — C 档 AI 主动产出落点（per ADR-0006 v2 + Phase 1c.1）。
// Phase 1c.1 brainstorm（2026-05-14 → ADR-0006 v2）拍板保留：作为 Note / 长答案 /
// 工具产物等 AI 主动产出的统一落地表。write path 已 ship（ADR-0020 §8 body_blocks
// 三态 SOT）：NoteGenerateTask（note_generate handler）生成 / editArtifactBodyBlocks
// （body-blocks-edit.ts）用户编辑 / persistNoteRefineApply（note-refine-apply.ts）AI
// Living Note patch / persistHubLinkDismiss（hub-dismiss.ts）。单 owner 写入约束见
// tests/integration/step9-invariant-audit.ts allowlist。
export const artifact = pgTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    parent_artifact_id: text('parent_artifact_id'),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    intent_source: text('intent_source').notNull(),
    source: text('source').notNull(),
    source_ref: text('source_ref'),
    body_blocks: jsonb('body_blocks').$type<ArtifactBodyBlocksT>(),
    attrs: jsonb('attrs').$type<JsonObject>().notNull().default({}),
    tool_kind: text('tool_kind'),
    tool_state: jsonb('tool_state').$type<ToolStateT>(),
    generation_status: text('generation_status').notNull().default('pending'),
    verification_status: text('verification_status').notNull().default('not_required'),
    verification_summary: jsonb('verification_summary').$type<NoteVerificationResultT>(),
    generated_by: jsonb('generated_by').$type<AgentRefT>(),
    verified_by: jsonb('verified_by').$type<AgentRefT>(),
    history: jsonb('history').$type<ArtifactHistoryEntryT[]>().notNull().default([]),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('artifact_live_note_hub_idx')
      .on(t.id)
      .where(sql`${t.type} = 'note_hub' AND ${t.archived_at} IS NULL`),
  ],
);

export const note_verification_claim = pgTable(
  'note_verification_claim',
  {
    artifact_id: text('artifact_id')
      .primaryKey()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    artifact_version: integer('artifact_version').notNull(),
    state: text('state').notNull(),
    fence: integer('fence').notNull().default(0),
    claim_token: uuid('claim_token'),
    task_run_id: text('task_run_id'),
    result_json: jsonb('result_json').$type<JsonObject>(),
    result_attempts: integer('result_attempts').notNull().default(0),
    provider_attempts: integer('provider_attempts').notNull().default(0),
    error_message: text('error_message'),
    available_at: timestamp('available_at', { withTimezone: true }).notNull(),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    provider_started_at: timestamp('provider_started_at', { withTimezone: true }),
    result_ready_at: timestamp('result_ready_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('note_verification_claim_recovery_idx').on(
      t.state,
      t.available_at,
      t.lease_expires_at,
      t.artifact_id,
    ),
    uniqueIndex('note_verification_claim_task_run_unique')
      .on(t.task_run_id)
      .where(sql`${t.task_run_id} IS NOT NULL`),
    check(
      'note_verification_claim_state_ck',
      sql`${t.state} IN ('retry_wait','reserved','provider_started','attempts_exhausted','ambiguous','result_ready','completed')`,
    ),
    check('note_verification_claim_fence_ck', sql`${t.fence} >= 0`),
    check(
      'note_verification_claim_shape_ck',
      sql`(
        (${t.state} = 'retry_wait' AND ${t.claim_token} IS NULL AND ${t.lease_expires_at} IS NULL AND ${t.provider_started_at} IS NULL)
        OR (${t.state} = 'reserved' AND ${t.claim_token} IS NOT NULL AND ${t.task_run_id} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL AND ${t.provider_started_at} IS NULL AND ${t.result_json} IS NULL)
        OR (${t.state} = 'provider_started' AND ${t.claim_token} IS NOT NULL AND ${t.task_run_id} IS NOT NULL AND ${t.provider_started_at} IS NOT NULL AND ${t.result_json} IS NULL)
        OR (${t.state} = 'attempts_exhausted' AND ${t.claim_token} IS NULL AND ${t.task_run_id} IS NULL AND ${t.lease_expires_at} IS NULL AND ${t.provider_started_at} IS NULL AND ${t.result_json} IS NULL AND ${t.error_message} IS NOT NULL)
        OR (${t.state} = 'ambiguous' AND (${t.provider_started_at} IS NOT NULL OR ${t.result_json} IS NOT NULL))
        OR (${t.state} = 'result_ready' AND ${t.result_json} IS NOT NULL AND ${t.lease_expires_at} IS NULL)
        OR (${t.state} = 'completed' AND ${t.result_json} IS NOT NULL AND ${t.completed_at} IS NOT NULL AND ${t.claim_token} IS NULL AND ${t.lease_expires_at} IS NULL)
      )`,
    ),
    check('note_verification_claim_result_attempts_ck', sql`${t.result_attempts} >= 0`),
    check(
      'note_verification_claim_provider_attempts_ck',
      sql`${t.provider_attempts} >= 0 AND ${t.provider_attempts} <= 3`,
    ),
  ],
);

export const artifact_block_ref = pgTable(
  'artifact_block_ref',
  {
    from_artifact_id: text('from_artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    from_block_id: text('from_block_id').notNull(),
    to_artifact_id: text('to_artifact_id')
      .notNull()
      .references(() => artifact.id),
    to_block_id: text('to_block_id'),
    // YUK-95 P5 (Wave 7 D4): discriminator so the generic cross_link
    // write-through (`syncBlockRefsForArtifact`) never clobbers the
    // embedded_check quiz rows that `embedded_check_generate` owns. New rows
    // default to 'cross_link'; the embedded_check writer sets 'embedded_check'.
    ref_kind: text('ref_kind').notNull().default('cross_link'),
  },
  (t) => [
    uniqueIndex('artifact_block_ref_unique').on(
      t.from_artifact_id,
      t.from_block_id,
      t.to_artifact_id,
      sql`COALESCE(${t.to_block_id}, '')`,
    ),
    index('artifact_block_ref_to_idx').on(t.to_artifact_id, t.to_block_id),
  ],
);

// YUK-384 — durable, PostgreSQL-authoritative hub-sync reconciliation cursor.
// Exactly one row per hub artifact (`type='note_hub'`), keyed by `artifact_id`.
// PostgreSQL topology triggers advance `generation` (bigint, crosses the TS
// boundary as a decimal string, never JS `number`) inside the writer's real
// transaction; `runHubSyncCycle` claims one generation at a time and finalizes
// behind advisory-lock / generation-token-lease / artifact-version / editing
// fences. The partial indexes, trigger functions, triggers, and live-hub
// backfill live in the hand-amended drizzle/0071_yuk384_durable_hub_sync.sql
// (drizzle-kit does not emit partial-index WHERE predicates or plpgsql).
export const hub_sync_reconciliation = pgTable(
  'hub_sync_reconciliation',
  {
    artifact_id: text('artifact_id')
      .primaryKey()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    actor_ref: text('actor_ref').notNull().default('hub_auto_sync'),
    // Defaults are declared as SQL literals (not `1n`/`0n`) because drizzle-kit
    // cannot JSON-serialize BigInt literal defaults into its snapshot; runtime
    // reads still use `mode: 'bigint'`.
    generation: bigint('generation', { mode: 'bigint' }).notNull().default(sql`1`),
    acknowledged_generation: bigint('acknowledged_generation', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    status: text('status').notNull().default('pending'),
    claim_owner: text('claim_owner'),
    claim_token: text('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    claim_count: integer('claim_count').notNull().default(0),
    consecutive_failure_count: integer('consecutive_failure_count').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    last_dirty_at: timestamp('last_dirty_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    last_claimed_at: timestamp('last_claimed_at', { withTimezone: true }),
    last_error_at: timestamp('last_error_at', { withTimezone: true }),
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }),
    last_outcome: text('last_outcome'),
    last_error_class: text('last_error_class'),
    last_error_code: text('last_error_code'),
    last_error: text('last_error'),
    last_desired_hash: text('last_desired_hash'),
    last_repair_key: text('last_repair_key'),
    last_observed_artifact_version: integer('last_observed_artifact_version'),
    last_applied_artifact_version: integer('last_applied_artifact_version'),
  },
  (table) => [
    check('hub_sync_actor_check', sql`${table.actor_ref} = 'hub_auto_sync'`),
    check('hub_sync_generation_check', sql`${table.generation} > 0`),
    check(
      'hub_sync_ack_generation_check',
      sql`${table.acknowledged_generation} >= 0 and ${table.acknowledged_generation} <= ${table.generation}`,
    ),
    check(
      'hub_sync_status_check',
      sql`${table.status} in ('pending','claimed','applying','retry_wait','acknowledged','cancelled')`,
    ),
    check(
      'hub_sync_claim_shape_check',
      sql`((${table.status} in ('claimed','applying')) = (${table.claim_owner} is not null and ${table.claim_token} is not null and ${table.lease_expires_at} is not null))`,
    ),
  ],
);

// YUK-384 — session-qualified editing presence. One row per (artifact, editor
// session); `last_heartbeat_at` drives the 30-second active/expired boundary the
// hub-sync finalizer consults under the shared advisory lock. Replaces the old
// single-`artifact_id` presence key so blur for session A never clears session B.
export const artifact_edit_session = pgTable(
  'artifact_edit_session',
  {
    artifact_id: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    session_id: text('session_id').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Named explicitly so the backing PK index is the conventional
    // `artifact_edit_session_pkey` (drizzle would otherwise emit a verbose
    // `_artifact_id_session_id_pk` composite name).
    primaryKey({
      name: 'artifact_edit_session_pkey',
      columns: [table.artifact_id, table.session_id],
    }),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Editing presence（YUK-321 M5 gate 选项 b）：web 进程写心跳、worker 进程读
// idle 决策的跨进程契约，Redis 退役（Task 9）后由本表承载。一 artifact 一行；
// pending 为编辑期被 defer 的 note-refine patch FIFO 队列（jsonb，日期用 ms
// epoch，沿 Redis 序列化形状）。本表是纯状态机存储非业务实体，不设
// created_at/updated_at——时间真相即 last_heartbeat_at。
//
// 行堆积：一 artifact 一行（upsert 不增行），单用户量级可忽略，不做清理 job
// （YAGNI）。陈旧 pending 在 load 时按 §4 裁决 (i) 丢弃（见 pg.ts）。
// ─────────────────────────────────────────────────────────────────────────────
export const editing_presence = pgTable('editing_presence', {
  artifact_id: text('artifact_id').primaryKey(),
  status: text('status').$type<'editing' | 'idle'>().notNull(),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
  // force-apply 时钟：首个 editing 心跳盖戳、idle 清空（types.ts L71-73 契约）。
  editing_started_at: timestamp('editing_started_at', { withTimezone: true }),
  pending: jsonb('pending').$type<SerializedQueuedPatch[]>().notNull().default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory reconciliation log（YUK-342 P2）：mem0 调和层 write-ahead 日志。
//
// 每条 mem0 add() 后，reconcile handler 用 GLM 判定该新 memory 与既有候选
// memory 的关系（KEEP_BOTH / SUPERSEDE / MERGE / RETRACT_NEW）。判定意图先写
// 到本表（planned 行，applied_at NULL = write-ahead），apply 完成后 UPDATE
// applied_at=now()。半途崩溃时 loadUnappliedLog 重放 applied_at IS NULL 行（幂等
// 续跑），hardDelete 命中 'not found' 被幂等吞掉。
//
// action 四值枚举 P2 起独立，不套 KG 侧 CorrectionKind（对象/时点/语义不同）。
// P4 知识侧写入期调和环是否共表 §8.5 开放。
// ─────────────────────────────────────────────────────────────────────────────
export const memory_reconciliation_log = pgTable(
  'memory_reconciliation_log',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    // mem0 vector row id（pgvector collection PK uuidv4）
    new_memory_id: text('new_memory_id'),
    old_memory_id: text('old_memory_id'),
    action: text('action').$type<'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW'>().notNull(),
    reason: text('reason').notNull(),
    llm_raw: jsonb('llm_raw'),
    // write-ahead 游标：planned_at = 意图写入时；applied_at NULL = 待重放。
    planned_at: timestamp('planned_at', { withTimezone: true }).notNull(),
    applied_at: timestamp('applied_at', { withTimezone: true }),
    // YUK-557（Q2b）— ARIES 级 undo：记决策元数据不够，必须记足以重建旧状态的原文。
    // write-ahead 阶段捕获（非 apply-time，防崩溃重放读到已改写值污染快照）。语义因
    // action 而异：SUPERSEDE/MERGE 存 old 行原文/完整 payload（被软取代/被吸收那份）——
    // prev_text 优先取 capturePrevState 读到的 DB 快照原文（verbatim 保真），candidate
    // text 仅作快照缺失时的兜底（PR #699 CR-5）；
    // RETRACT_NEW 的 prev_text 存 new 行原文（被丢弃那份），prev_metadata 留 NULL（其
    // metadata 由本项目 inferred event-memory add 刚写、可从 event 表溯源）。KEEP_BOTH 恒 NULL。
    // 可空——不回填历史行。恢复 runbook：docs/runbooks/memory-reconcile-undo.md。
    prev_text: text('prev_text'),
    prev_metadata: jsonb('prev_metadata'),
  },
  (t) => [
    index('memory_recon_user_idx').on(t.user_id),
    index('memory_recon_unapplied_idx').on(t.applied_at),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge reconciliation log（YUK-344 调和环增量 2，ADR-0034 §3）：知识边写入期
// 调和层 AUDIT / PROVENANCE 日志（**不是 write-ahead replay 游标**）。
//
// 与 memory_reconciliation_log（mem0 个性化轴）**结构正交**——OWNER RULING：另立
// 新表，**不复用** memory 表（结构轴 ≠ 记忆轴，无 user_id 哨兵）。每条知识边提议
// 通过拓扑闸后，reconcile handler 用 GLM 判定该候选边与既有相邻 live 边的关系
// （KEEP_BOTH / SUPERSEDE，结构边二动作空间，edge-reconcile.ts）。SUPERSEDE 的整段
// apply（落本表 planned 行 → 写新 live 边 → 归档旧边 → correction event → 盖
// applied_at）跑在**单个 db.transaction**（propose_edge.ts applyEdgeSupersede）里：
// 崩溃整体回滚（连本表行一起），**没有半途状态可重放**。本表只是 SUPERSEDE 决策的
// 审计记录（planned_at / applied_at 标注 apply 是否在该 tx 内走完）。防双写靠
// knowledge_edge UNIQUE(from,to,relation_type) 约束 + skipped_duplicate_edge
// （重复候选在 apply 前就跳过），**不靠确定性 id**——每个 event/edge id 都是 fresh
// createId()。
//
// SUPERSEDE 的实际移除走 knowledge_edge.archived_at 软归档（ADR-0034 §4 load-bearing
// 移除）；本表 + 一条 CorrectionKind correction event 只记 epistemic 来由 provenance。
//
// action 二值枚举（KEEP_BOTH/SUPERSEDE），不套 memory 侧四值——结构边无文本可
// MERGE、RETRACT_NEW 由上游拓扑/语义闸承接（edge-reconcile.ts 模块头）。
// 行堆积：单用户量级可忽略，不做清理 job（YAGNI），与 memory 表同纪律。
// ─────────────────────────────────────────────────────────────────────────────
export const edge_reconciliation_log = pgTable(
  'edge_reconciliation_log',
  {
    id: text('id').primaryKey(),
    // 候选边键三元组（from|to|relation_type）——审计锚，记录这条 SUPERSEDE 针对的
    // 候选边（候选边落库前无自身 UUID，故用三元组而非 edge id）。
    candidate_from_knowledge_id: text('candidate_from_knowledge_id').notNull(),
    candidate_to_knowledge_id: text('candidate_to_knowledge_id').notNull(),
    candidate_relation_type: text('candidate_relation_type').notNull(),
    // 调和判定结果。SUPERSEDE 时 superseded_edge_id 指向被归档的旧 live 边。
    action: text('action').$type<'KEEP_BOTH' | 'SUPERSEDE'>().notNull(),
    // 被取代的旧 knowledge_edge.id（仅 SUPERSEDE 非空）。
    superseded_edge_id: text('superseded_edge_id'),
    // 判定置信度（applyConfidenceThreshold 后；低置信已降级为 KEEP_BOTH）。
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    // GLM 原始决策（审计；KEEP_BOTH 短路无 GLM 调用 / 降级时可为 null）。
    llm_raw: jsonb('llm_raw'),
    // 审计时间戳：planned_at = 决策落本表时；applied_at = 同一 apply tx 末尾盖戳
    //（NULL 只会出现在 apply tx 内部的瞬时，提交后总是非 NULL——崩溃则整行回滚）。
    planned_at: timestamp('planned_at', { withTimezone: true }).notNull(),
    applied_at: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    index('edge_recon_candidate_idx').on(
      t.candidate_from_knowledge_id,
      t.candidate_to_knowledge_id,
      t.candidate_relation_type,
    ),
    index('edge_recon_unapplied_idx').on(t.applied_at),
    // action ↔ superseded_edge_id consistency invariant, enforced at the DB layer
    // (not just the application layer): a SUPERSEDE row MUST name the archived old
    // edge (superseded_edge_id non-null), and a KEEP_BOTH row MUST NOT (null).
    // Mirrors the decision builder in edge-reconcile.ts (SUPERSEDE → neighbor.edge_id,
    // KEEP_BOTH → null) so the DB can never persist a contradictory audit row.
    check(
      'edge_recon_action_superseded_ck',
      sql`(${t.action} = 'SUPERSEDE' AND ${t.superseded_edge_id} IS NOT NULL) OR (${t.action} = 'KEEP_BOTH' AND ${t.superseded_edge_id} IS NULL)`,
    ),
  ],
);

// YUK-531 (A5 S4 / ADR-0036 RT1) — write-time reconciliation AUDIT log for the
// HETEROGENEOUS misconception_edge ring. The misconception-side parallel to
// edge_reconciliation_log (structural knowledge-edge ring), kept SEPARATE because
// the misconception ring is IMPERATIVE (archived_at soft-archive + upsert), NOT
// event-sourced/fold-replayed — misconception has no fold/projection (see
// misconception-reconcile.ts). This table is decision AUDIT / provenance only:
// the actual SUPERSEDE removal is archiveMisconceptionEdge (archived_at). Candidate
// is recorded by its 5-tuple key (the candidate edge has no UUID before it lands).
// action ∈ KEEP_BOTH | SUPERSEDE (the 2-action structural space, mirrors the edge
// ring); the action ↔ superseded_edge_id consistency CHECK is enforced at the DB
// layer (a SUPERSEDE row MUST name the archived loser; KEEP_BOTH MUST NOT).
export const misconception_reconciliation_log = pgTable(
  'misconception_reconciliation_log',
  {
    id: text('id').primaryKey(),
    // 候选误区边 5 元组键（候选边落库前无自身 UUID，故用元组而非 edge id）。
    candidate_from_kind: text('candidate_from_kind').notNull(),
    candidate_from_id: text('candidate_from_id').notNull(),
    candidate_to_kind: text('candidate_to_kind').notNull(),
    candidate_to_id: text('candidate_to_id').notNull(),
    candidate_relation_type: text('candidate_relation_type').notNull(),
    // 调和判定结果。SUPERSEDE 时 superseded_edge_id 指向被归档的旧 live 误区边。
    action: text('action').$type<'KEEP_BOTH' | 'SUPERSEDE'>().notNull(),
    // 被取代的旧 misconception_edge.id（仅 SUPERSEDE 非空）。
    superseded_edge_id: text('superseded_edge_id'),
    // 判定置信度（applyConfidenceThreshold 后；低置信已降级为 KEEP_BOTH）。
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    // GLM 原始决策（审计；KEEP_BOTH 短路无 GLM 调用 / 降级时可为 null）。
    llm_raw: jsonb('llm_raw'),
    // 审计时间戳：planned_at = 决策落本表时；applied_at = 同一 apply tx 末尾盖戳。
    planned_at: timestamp('planned_at', { withTimezone: true }).notNull(),
    applied_at: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    index('misconception_recon_candidate_idx').on(
      t.candidate_from_id,
      t.candidate_to_id,
      t.candidate_relation_type,
    ),
    index('misconception_recon_unapplied_idx').on(t.applied_at),
    // action ↔ superseded_edge_id consistency invariant, enforced at the DB layer
    // (mirrors edge_recon_action_superseded_ck): a SUPERSEDE row MUST name the
    // archived old edge (non-null), a KEEP_BOTH row MUST NOT (null).
    check(
      'misconception_recon_action_superseded_ck',
      sql`(${t.action} = 'SUPERSEDE' AND ${t.superseded_edge_id} IS NOT NULL) OR (${t.action} = 'KEEP_BOTH' AND ${t.superseded_edge_id} IS NULL)`,
    ),
  ],
);
