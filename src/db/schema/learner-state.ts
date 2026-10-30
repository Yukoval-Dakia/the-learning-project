// Learner state: FSRS / mastery / KC state, the knowledge_mastery view,
// interventions, axis state, goals, and placement starter tables.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { RtCorrectBuffer as RtCorrectBufferJson } from '../../core/theta';
import type { ThetaGridPosterior as ThetaGridPosteriorJson } from '../../core/theta-grid';
import { event } from './events';
import { question } from './question';

type FsrsStateT = import('@/core/schema/scheduling-state').SchedulingState;
type JsonObject = Record<string, unknown>;

// FSRS state projection per review subject. YUK-203 P3 schedules knowledge-
// labeled questions by `subject_kind='knowledge'`; unlabeled legacy questions
// may still use `subject_kind='question'`.
// Latest state is derived from `event(action='review', subject_kind='question')`.
export const material_fsrs_state = pgTable(
  'material_fsrs_state',
  {
    id: text('id').primaryKey(),
    // 'knowledge' for labeled questions; 'question' remains a legacy fallback.
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

// ─────────────────────────────────────────────────────────────────────────────
// B1-W1 (ADR-0035 决定#2) — mastery_state：诊断维 p(L) 的物化载体。
//
// 取代 knowledge_mastery VIEW 作为 p(L) 诊断维的 SoT。YUK-420 起 view 消费端已切：
// getMasteryProjection（src/kernel/read-models/mastery-projection.ts）是唯一展示/AI 读，投影 = 难度感知
// PFA p(L)（σ(γ·success + ρ·fail − β)，β=KC 代表性 hard-track item 难度 + ADR-0035
// 置信带），不再是 view 的占位也不再是 interim σ(θ̂)@b=0。per-knowledge 一行，
// subject_kind 固定 'knowledge'（与 material_fsrs_state 的 subject_kind 平行，但语义
// 正交：FSRS=R 调度轴，这里=p(L) 诊断轴，三轴正交红线 ADR-0035）。
//
// 在线诊断写入：src/kernel/records/mastery-state.ts；结算 tx 内调 updateThetaForAttempt。
// 快照恢复的 cold-start delete 与联合标定尺度修正各守原 owner。
//
// 列分硬轨（本 wave 写）/ 软轨占位（本 wave NULL，进 audit allowlist）：
//   硬轨：theta_hat, evidence_count, success_count, fail_count, last_outcome_at
//   软轨占位：calibration_residual（fixed-anchor 残差，Wave2 复盘路径才写）,
//             fluency_illusion_flag（流畅度幻觉，复盘触发才置位）
// ─────────────────────────────────────────────────────────────────────────────
export const mastery_state = pgTable(
  'mastery_state',
  {
    id: text('id').primaryKey(),
    // 固定 'knowledge'——诊断维只在知识点粒度累积（PFA per-KC，B1 foundation）。
    // 列保留是为与 material_fsrs_state 形态平行 + 未来粒度扩展留口。
    subject_kind: text('subject_kind').notNull().default('knowledge'),
    subject_id: text('subject_id').notNull(),
    // θ̂：个体能力估计，logit 尺度（与 b 同度量，B1 foundation）。
    // DEFAULT 0 = logit 原点（先验中性），冷启首次 attempt 从此出发。
    theta_hat: doublePrecision('theta_hat').notNull().default(0),
    // K schedule + credit-assignment 的输入。DEFAULT 0，每次 attempt +1。
    evidence_count: integer('evidence_count').notNull().default(0),
    // PFA 天然形态：per-KC success/fail 累积计数（B1 foundation）。
    // 它们也是 credit-assignment 缓冲器（高 success → 该 KC 受冲击小，VERIFY:multi-kc）。
    success_count: integer('success_count').notNull().default(0),
    fail_count: integer('fail_count').notNull().default(0),
    last_outcome_at: timestamp('last_outcome_at', { withTimezone: true }),
    // YUK-361 Phase 2 (Urnings-Lite θ 不确定性) — θ̂ 的累积 Fisher information。
    // 每次 attempt += weight²·p(1−p)（同 θ̂ 更新的 b 锚 + bWeight，见 state.ts）。
    // DEFAULT 1 = 弱先验 1 单位信息（SE=1），既有行 backfill-safe。**不存 theta_se**——
    // SE 从此列派生（thetaSe，src/core/theta.ts）。后续 MFI 用它给高不确定 θ 降权。
    theta_precision: doublePrecision('theta_precision').notNull().default(1),
    // 本次 attempt 的 θ̂ 变化量（newTheta − thetaBefore），可观测/调试用。nullable：
    // 冷启或从未 attempt 的行为 NULL。default 1 不适用（这是有符号增量非信息量）。
    last_theta_delta: real('last_theta_delta'),
    // A4 (YUK-436) — 离散网格贝叶斯 θ_KC OFFSET 后验的 SHADOW 持久化（inc-1）。
    // { probs: number[41], evidence: number }（支撑点是 GRID_THETA 模块常量，不持久化）。
    // inc-1 是 PURE-ADDITIVE SHADOW：theta_hat 仍是 SoT，本列只在 THETA_GRID_ENABLED=true
    // 且单 KC 题时写，**无任何 inc-1 下游读者**（不喂 p(L)/effectiveB/选题）。flag OFF（默认）
    // 恒 NULL。校准验证后才在 inc-2（grid→SoT cut-over，必须排在 A3 之后）接读侧。
    // 进 audit-schema allowlist（写路径存在但 inc-1 无 live reader）。
    theta_grid_json: jsonb('theta_grid_json').$type<ThetaGridPosteriorJson>(),
    // A1 (YUK-449) — per-KC rolling correct-RT ring buffer (last ≤ SRT_RT_BUFFER_K answered-
    // correct response times, ms). Collection and snapshot restore remain; θ̂ uses only
    // the population-seeded SRT time limit (YUK-1576).
    rt_correct_ms: jsonb('rt_correct_ms').$type<RtCorrectBufferJson>(),
    // 软轨占位（本 wave 不写，进 audit allowlist，kind:'manual' 解除）:
    // fixed-anchor 慢热校准残差——Wave2 复盘/锚校准路径才写。n=1 结构性受锚质量约束。
    calibration_residual: real('calibration_residual'),
    // 流畅度幻觉旗——A2 复盘判定才置位（Wave2）。本 wave 恒 NULL。
    fluency_illusion_flag: boolean('fluency_illusion_flag'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mastery_state_unique').on(t.subject_kind, t.subject_id),
    index('mastery_state_subject_idx').on(t.subject_id),
  ],
);

// YUK-440 (A13 typed KC ledger) — kc_typed_state: the single-writer PROJECTION over
// RESOLVED conjecture/probe evidence, mirroring mastery_state's shape (diagnostic
// projection keyed by knowledge subject_id, no enforced FK). One row per
// (subject_kind, subject_id=knowledge_id), single-writer = upsertKcTypedState
// (advisory-lock namespace `kc_typed:…`, distinct from mastery_state's `fsrs:`/`mastery:`).
// typed_state is a loose-text tri-state; `confused-with-X` is written ONLY when a
// discriminating probe + recurrence≥2 confirm it (§修正-4). `mastered` is reserved for
// the post-Rust-scorer claim-survival FLIP (ADR-0046) and is NOT written in this MVP.
// Provenance = evidence_event_ids (loose text refs to event.id, no FK). Derived-but-
// physical → FK_ORDER (rebuildable from the event log via a future foldKcTypedState, but
// a peer of mastery_state) — NOT BACKUP_EXCLUDED.
export const kc_typed_state = pgTable(
  'kc_typed_state',
  {
    id: text('id').primaryKey(),
    subject_kind: text('subject_kind').notNull().default('knowledge'),
    subject_id: text('subject_id').notNull(),
    // 'no-evidence' | 'confused-with-X' | 'mastered'. default 'no-evidence'.
    // 'mastered' is FLIP-only (post-Rust-scorer), unwritten in this MVP.
    typed_state: text('typed_state').notNull().default('no-evidence'),
    // when typed_state='confused-with-X', the KC this learner confuses it with
    // (loose text ref to knowledge.id, no FK). NULL otherwise.
    confused_with_kc_id: text('confused_with_kc_id'),
    // 'open' | 'resolved' — the conjecture/probe lifecycle for this cell.
    lifecycle: text('lifecycle').notNull().default('open'),
    // provenance: event ids (conjecture / probe_result / prediction_score) backing the
    // current state. Loose text[] refs, no FK. Append-union on each write.
    evidence_event_ids: jsonb('evidence_event_ids').$type<string[]>().notNull().default([]),
    last_evidence_at: timestamp('last_evidence_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kc_typed_state_unique').on(t.subject_kind, t.subject_id),
    index('kc_typed_state_subject_idx').on(t.subject_id),
  ],
);

// YUK-791 — versioned intervention preparation aggregate.
//
// One row is one immutable preparation version. `id` is stable across reprepare;
// `(id, version)` is the aggregate key. Agency is the only lifecycle writer.
// Practice returns authored package candidates through a public port but never
// mutates this table. Snapshot/recommendation/package/attempt JSON are parsed
// through the canonical Zod contracts at every store boundary.
//
// This is authored, causally important state (not a disposable worker cache), so
// it belongs in FK_ORDER and bumps the backup schema version.
export const intervention = pgTable(
  'intervention',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    revision: integer('revision').notNull().default(0),
    source_probe_result_event_id: text('source_probe_result_event_id').notNull(),
    conjecture_event_id: text('conjecture_event_id').notNull(),
    status: text('status', {
      enum: ['preparing', 'preparation_failed', 'active', 'needs_revision', 'settled', 'canceled'],
    })
      .notNull()
      .default('preparing'),
    delivery_mode: text('delivery_mode', { enum: ['shadow', 'eligible'] })
      .notNull()
      .default('shadow'),
    outcome: text('outcome', { enum: ['effective', 'ineffective', 'inconclusive'] }),
    idempotency_key: text('idempotency_key').notNull(),
    preparation_job_id: text('preparation_job_id'),
    snapshot_json: jsonb('snapshot_json').$type<JsonObject>().notNull(),
    recommendation_json: jsonb('recommendation_json').$type<JsonObject>(),
    package_json: jsonb('package_json').$type<JsonObject>(),
    settlement_json: jsonb('settlement_json').$type<JsonObject>(),
    preparation_attempts_json: jsonb('preparation_attempts_json')
      .$type<JsonObject[]>()
      .notNull()
      .default([]),
    failure_code: text('failure_code'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    activated_at: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    uniqueIndex('intervention_source_version_uq').on(t.source_probe_result_event_id, t.version),
    uniqueIndex('intervention_idempotency_key_uq').on(t.idempotency_key),
    uniqueIndex('intervention_one_preparing_version_uq')
      .on(t.id)
      .where(sql`${t.status} = 'preparing'`),
    index('intervention_status_updated_idx').on(t.status, t.updated_at.desc()),
    index('intervention_conjecture_idx').on(t.conjecture_event_id, t.version.desc()),
    foreignKey({
      columns: [t.source_probe_result_event_id],
      foreignColumns: [event.id],
      name: 'intervention_source_probe_result_event_fk',
    }),
    foreignKey({
      columns: [t.conjecture_event_id],
      foreignColumns: [event.id],
      name: 'intervention_conjecture_event_fk',
    }),
    check('intervention_version_positive_ck', sql`${t.version} > 0`),
    check('intervention_revision_nonnegative_ck', sql`${t.revision} >= 0`),
    check(
      'intervention_status_ck',
      sql`${t.status} IN ('preparing','preparation_failed','active','needs_revision','settled','canceled')`,
    ),
    check('intervention_delivery_mode_ck', sql`${t.delivery_mode} IN ('shadow','eligible')`),
    check(
      'intervention_outcome_ck',
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('effective','ineffective','inconclusive')`,
    ),
    check(
      'intervention_attempts_array_ck',
      sql`jsonb_typeof(${t.preparation_attempts_json}) = 'array'`,
    ),
    check(
      'intervention_active_shape_ck',
      sql`${t.status} <> 'active' OR (
        ${t.recommendation_json} IS NOT NULL
        AND ${t.recommendation_json}->>'kind' = 'recommendation'
        AND ${t.package_json} IS NOT NULL
        AND jsonb_typeof(${t.package_json}) = 'object'
        AND ${t.settlement_json} IS NOT NULL
        AND jsonb_typeof(${t.settlement_json}) = 'object'
        AND ${t.failure_code} IS NULL
        AND ${t.activated_at} IS NOT NULL
      )`,
    ),
    check(
      'intervention_settled_shape_ck',
      sql`${t.status} <> 'settled' OR (
        ${t.outcome} IS NOT NULL
        AND ${t.settlement_json} IS NOT NULL
        AND ${t.settlement_json}->>'completed_at' IS NOT NULL
      )`,
    ),
    check(
      'intervention_failed_shape_ck',
      sql`${t.status} <> 'preparation_failed' OR (
        ${t.failure_code} IS NOT NULL
        AND ${t.activated_at} IS NULL
      )`,
    ),
  ],
);

// YUK-445 (A11 — 谨慎 / 速度-精度轴) — learner_axis_state: per-KC SLOW-VARYING descriptor
// recovered by EZ-diffusion (Wagenmakers 2007) from this learner's own RT + accuracy.
//
// No scheduled writer: YUK-1560 retired the nightly batch. Rows are only renamed/frozen when
// knowledge nodes merge (peer of mastery_state / kc_typed_state — diagnostic projection keyed
// by knowledge subject_id, no enforced FK). Historical columns stay event-derived: attempt
// events' duration_ms + outcome, never θ̂ / FSRS / scheduling state — a DESCRIPTOR only with NO
// live estimation consumer (read-out is display-only via placement-profile). So A11 touches no
// LIVE engine and needs no dark-ship flag.
//
// n=1 admissibility: drift_v / boundary_a / ter are recovered from ONE learner's sufficient
// statistics (Pc, correct-RT mean/variance). boundary_a is THIS learner's response caution —
// it is NOT a 2PL item discrimination (the litmus-forbidden between-subject-variance family).
//
// drift_v vs boundary_a/ter provenance gate (the A11 hard boundary): in an ADAPTIVE flow item
// selection pins Pc, confounding the drift interpretation, so `drift_v` is persisted ONLY for
// provenance='probe' (a non-adaptive fixed-difficulty probe-set). The retired nightly writer
// wrote boundary_a + ter and left drift_v NULL. (No non-adaptive probe-set source exists; the
// probe-set flip stays deferred.)
//
// n_obs = total scored responses backing the recovery (usage-gate provenance, NOT a θ count).
// NOTE: A10 (confidence/calibration_curve, YUK-444) is HOLD; when it lands it adds its own
// `calibration_curve_json` column to THIS table (an additive COLUMN — no SCHEMA_VERSION bump,
// per the export-constants 表=bump/列=不bump convention), making it the table's second writer.
export const learner_axis_state = pgTable(
  'learner_axis_state',
  {
    id: text('id').primaryKey(),
    subject_kind: text('subject_kind').notNull().default('knowledge'),
    subject_id: text('subject_id').notNull(),
    // drift rate v (evidence-accumulation speed). NULL unless provenance='probe' (confounded
    // by adaptive item selection — A11 hard boundary). nullable by design.
    drift_v: doublePrecision('drift_v'),
    // boundary separation a — this learner's response caution (NOT item discrimination).
    // nullable: NULL when the EZ recovery is degenerate (chance Pc) or gate not met.
    boundary_a: doublePrecision('boundary_a'),
    // non-decision time Ter (seconds) — motor/encoding baseline. nullable as above.
    ter: doublePrecision('ter'),
    // total scored responses the recovery folded (usage-gate evidence). DEFAULT 0.
    n_obs: integer('n_obs').notNull().default(0),
    // 'adaptive' | 'probe' — which response source produced this row. Gates drift_v
    // persistence. DEFAULT 'adaptive' (historical rows; no current writer).
    provenance: text('provenance').notNull().default('adaptive'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('learner_axis_state_unique').on(t.subject_kind, t.subject_id),
    index('learner_axis_state_subject_idx').on(t.subject_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-143 / ADR-0025 — North-Star `goal` entity (Wave-9 core).
//
// A goal is a long-lived, usually subject-scoped learning intent ("能流畅读
// 《史记》"). It is materialized from a `goal_scope` AiProposal being accepted
// (evidence-first): create/confirm go through the event log, the goal row's
// `source_ref` points at the propose event id. Multiple goals run in parallel
// (ND-1); a goal only ADDS direction (soft bias + tags) and never suppresses
// FSRS-due reviews or other capture tasks (ND-5 — see ADR-0025).
//
// `sequence_hint` is AI-internal ordering only — NOT surfaced as progress
// (ND-4: no progress bar / % complete). `learning_session.goal_id` stays a
// stub (NOT an FK to goal.id): a goal spans many sessions, so binding it to a
// single session is the wrong cardinality (ADR-0025 decision 1).
export const goal = pgTable(
  'goal',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    // nullable — cross-subject goals are allowed (ND-1).
    subject_id: text('subject_id'),
    // AI-inferred + user-confirmed knowledge nodes the goal covers.
    scope_knowledge_ids: jsonb('scope_knowledge_ids').$type<string[]>().notNull().default([]),
    // YUK-603 — how scope_knowledge_ids is meant to be read:
    //   'explicit'     → the frozen set above is the authoritative narrow scope (hand-picked
    //                    KCs / an accepted proposal's evidence-first selection).
    //   'subject_live' → scope derives from subject_id at READ time (subject=view); the frozen
    //                    column stays [] and readers ignore it. A subject goal must never
    //                    freeze its derivation — the write-time snapshot pinned the synthetic
    //                    seed root and blinded placement tier-1 + the goal-strand readers.
    scope_mode: text('scope_mode', { enum: ['explicit', 'subject_live'] })
      .notNull()
      .default('explicit'),
    // AI-internal sequencing hint; NOT a progress metric (ND-4).
    sequence_hint: integer('sequence_hint').notNull().default(0),
    // YUK-1009 — learner-declared curriculum stage (学段), captured at onboarding via
    // POST /api/goals and mutable via the goal_scope_update command path (the goal is the
    // durable home because goals already key placement/supply scoping). CURRICULUM
    // constraint only — NEVER an ability/θ̂ input. NULL = undeclared (older goals,
    // proposal-materialized goals, learners who skipped the question). Canonical
    // vocabulary: DeclaredStage in src/core/schema/business.ts (literal tuple kept
    // inline because this file only type-imports core schema).
    declared_stage: text('declared_stage', {
      enum: ['middle_school', 'high_school', 'university', 'custom'],
    }),
    // 'active' | 'dormant' | 'done'
    status: text('status', { enum: ['active', 'dormant', 'done'] })
      .notNull()
      .default('active'),
    // provenance: how this goal came to exist, e.g. 'goal_scope_proposal'.
    // set-once at materialization (see audit-schema allowlist note).
    source: text('source').notNull(),
    // the propose event id that materialized this goal (evidence chain).
    // set-once at materialization.
    source_ref: text('source_ref'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('goal_status_idx').on(t.status, t.sequence_hint, t.created_at),
    index('goal_subject_idx').on(t.subject_id),
    // YUK-733: indexes the `scope_knowledge_ids @> '["<kc>"]'::jsonb` containment read on
    // the KC-merge scope-rewrite path (proposals.ts) + orphan-surface backfill.
    // jsonb_path_ops supports @> and is smaller/faster than the default jsonb_ops.
    index('goal_scope_knowledge_ids_gin').using(
      'gin',
      sql`${t.scope_knowledge_ids} jsonb_path_ops`,
    ),
  ],
);

export const placement_starter_claim = pgTable(
  'placement_starter_claim',
  {
    id: text('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    goal_id: text('goal_id').notNull(),
    semantic_goal_revision_id: text('semantic_goal_revision_id').notNull(),
    subject_id: text('subject_id').notNull(),
    knowledge_id: text('knowledge_id').notNull(),
    demand_id: text('demand_id').notNull(),
    target_id: text('target_id').notNull(),
    status: text('status', {
      enum: [
        'pending_dispatch',
        'queued',
        'running',
        'verifying',
        'retry_scheduled',
        'satisfied',
        'exhausted',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending_dispatch'),
    pg_boss_job_id: text('pg_boss_job_id'),
    max_paid_attempts: integer('max_paid_attempts').notNull().default(3),
    budget_limit_micro_usd: integer('budget_limit_micro_usd').notNull().default(1_000_000),
    known_cost_micro_usd: integer('known_cost_micro_usd').default(0),
    next_reconcile_at: timestamp('next_reconcile_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    satisfied_at: timestamp('satisfied_at', { withTimezone: true }),
    exhausted_at: timestamp('exhausted_at', { withTimezone: true }),
    last_error_class: text('last_error_class'),
    last_error_code: text('last_error_code'),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    uniqueIndex('placement_starter_claim_fingerprint_uq').on(t.fingerprint),
    uniqueIndex('placement_starter_claim_revision_subject_uq').on(
      t.semantic_goal_revision_id,
      t.subject_id,
    ),
    uniqueIndex('placement_starter_claim_job_uq')
      .on(t.pg_boss_job_id)
      .where(sql`${t.pg_boss_job_id} IS NOT NULL`),
    // At most one IN-FLIGHT (paid) claim per (goal, subject). The claim id / fingerprint /
    // (revision, subject) uniqueness already pins one row per goal REVISION; this partial index
    // is the cross-revision budget guard: once a goal is edited (new semantic_goal_revision_id →
    // new claim id) while an earlier revision's claim is still generating, both revisions would
    // otherwise dispatch concurrent paid generation batches into the SAME goal pool
    // (addPlacementStarterKnowledgeToExplicitGoal unions every revision's synthetic KC into the
    // goal scope). Keying the partial unique on (id) — the PK — enforced nothing (YUK-452 review).
    //
    // 'pending_dispatch' is DELIBERATELY EXCLUDED from the predicate (YUK-452 round-2): a claim
    // that never dispatched has spent NOTHING and must not block a new revision's claim. Otherwise
    // a claim stranded 'pending_dispatch' by a failed dispatch tx would permanently block every
    // later revision for that goal+subject — placement soft-stuck forever.
    // The paid single-flight invariant is preserved: paid work only begins once a claim reaches
    // 'queued' (acquirePlacementAttempt requires queued+), so gating on {queued, running, verifying,
    // retry_scheduled} still admits exactly one paid flight. The pending→queued transition in
    // dispatchPlacementStarterClaimTx catches the resulting 23505 inside a savepoint, rolls back
    // the losing enqueue, and KEEPS that claim pending: it may be the current authoritative
    // revision and must remain retryable after the old paid flight ends.
    uniqueIndex('placement_starter_claim_nonterminal_uq')
      .on(t.goal_id, t.subject_id)
      .where(sql`${t.status} IN ('queued','running','verifying','retry_scheduled')`),
    // YUK-761 — LIVE CONSUMER: sweepStalePlacementStarterClaims
    // (src/capabilities/practice/server/placement-starter-recovery.ts), run from the tail of the
    // question_supply_nightly job. Its three independently capped scans cover pending_dispatch,
    // retry_scheduled, and queued/running/verifying with `next_reconcile_at <= now() ORDER BY
    // next_reconcile_at, created_at`: re-drive never-dispatched claims, reap dead retries, and use
    // queue expiry / attempt lease + job liveness to fence lost in-flight deliveries.
    // `next_reconcile_at` doubles as that sweeper's acquire cursor (conditional-UPDATE CAS), which
    // is why the sweeper moves it WITHOUT touching updated_at/version.
    index('placement_starter_claim_recovery_idx')
      .on(t.next_reconcile_at, t.created_at)
      .where(
        sql`${t.status} IN ('pending_dispatch','queued','running','verifying','retry_scheduled')`,
      ),
    check(
      'placement_starter_claim_status_check',
      sql`${t.status} IN ('pending_dispatch','queued','running','verifying','retry_scheduled','satisfied','exhausted','cancelled')`,
    ),
    check('placement_starter_claim_max_attempts_v1', sql`${t.max_paid_attempts} = 3`),
    check(
      'placement_starter_claim_nonnegative_cost',
      sql`${t.budget_limit_micro_usd} >= 0 AND (${t.known_cost_micro_usd} IS NULL OR ${t.known_cost_micro_usd} >= 0)`,
    ),
    check(
      'placement_starter_claim_terminal_timestamps',
      sql`(${t.status} = 'satisfied') = (${t.satisfied_at} IS NOT NULL) AND (${t.status} = 'exhausted') = (${t.exhausted_at} IS NOT NULL)`,
    ),
  ],
);

export const placement_starter_attempt = pgTable(
  'placement_starter_attempt',
  {
    id: text('id').primaryKey(),
    claim_id: text('claim_id')
      .notNull()
      .references(() => placement_starter_claim.id),
    pg_boss_job_id: text('pg_boss_job_id').notNull(),
    delivery_no: integer('delivery_no').notNull(),
    fencing_token: uuid('fencing_token').notNull(),
    status: text('status', {
      enum: [
        'running',
        'verifying',
        'succeeded',
        'underfilled',
        'timed_out',
        'interrupted',
        'invariant_failed',
      ],
    }).notNull(),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    provider_task_run_id: text('provider_task_run_id'),
    provider_output_hash: text('provider_output_hash'),
    provider_output_recorded_at: timestamp('provider_output_recorded_at', { withTimezone: true }),
    error_class: text('error_class'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('placement_starter_attempt_id_claim_uq').on(t.id, t.claim_id),
    uniqueIndex('placement_starter_attempt_fence_uq').on(t.fencing_token),
    uniqueIndex('placement_starter_attempt_delivery_uq').on(
      t.claim_id,
      t.pg_boss_job_id,
      t.delivery_no,
    ),
    uniqueIndex('placement_starter_attempt_active_uq')
      .on(t.claim_id)
      .where(sql`${t.status} IN ('running','verifying')`),
    check(
      'placement_starter_attempt_status_check',
      sql`${t.status} IN ('running','verifying','succeeded','underfilled','timed_out','interrupted','invariant_failed')`,
    ),
    check('placement_starter_attempt_delivery_range', sql`${t.delivery_no} BETWEEN 1 AND 3`),
  ],
);

export const placement_starter_attempt_question = pgTable(
  'placement_starter_attempt_question',
  {
    attempt_id: text('attempt_id')
      .notNull()
      .references(() => placement_starter_attempt.id),
    claim_id: text('claim_id')
      .notNull()
      .references(() => placement_starter_claim.id),
    question_id: text('question_id')
      .notNull()
      .references(() => question.id),
    canonical_hash: text('canonical_hash').notNull(),
    verification_authority_epoch: uuid('verification_authority_epoch').notNull(),
    verification_status: text('verification_status').notNull().default('authorized'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.attempt_id, t.claim_id],
      foreignColumns: [placement_starter_attempt.id, placement_starter_attempt.claim_id],
      name: 'placement_starter_attempt_question_attempt_claim_fk',
    }),
    check(
      'placement_starter_attempt_question_verification_status_check',
      sql`${t.verification_status} IN ('authorized','satisfied','failed','cancelled','exhausted','superseded')`,
    ),
    primaryKey({ columns: [t.attempt_id, t.question_id] }),
    uniqueIndex('placement_starter_attempt_question_claim_uq').on(t.claim_id, t.question_id),
    uniqueIndex('placement_starter_attempt_question_authority_uq').on(
      t.attempt_id,
      t.question_id,
      t.verification_authority_epoch,
    ),
  ],
);

export const placement_starter_cost_component = pgTable(
  'placement_starter_cost_component',
  {
    id: text('id').primaryKey(),
    claim_id: text('claim_id')
      .notNull()
      .references(() => placement_starter_claim.id),
    attempt_id: text('attempt_id')
      .notNull()
      .references(() => placement_starter_attempt.id),
    component_kind: text('component_kind', {
      enum: ['quiz_gen', 'quiz_verify', 'solution_check', 'teaching_quality'],
    }).notNull(),
    question_id: text('question_id').references(() => question.id),
    provider_task_run_id: text('provider_task_run_id').notNull(),
    cost_micro_usd: integer('cost_micro_usd'),
    over_cap: boolean('over_cap'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.attempt_id, t.claim_id],
      foreignColumns: [placement_starter_attempt.id, placement_starter_attempt.claim_id],
      name: 'placement_starter_cost_component_attempt_claim_fk',
    }),
    uniqueIndex('placement_starter_cost_component_idempotency_uq').on(
      t.provider_task_run_id,
      t.component_kind,
      sql`COALESCE(${t.question_id}, '')`,
    ),
    // known_cost recompute (addAuthorizedCostComponent / addPlacementStarterCostComponent) and
    // budget settlement sum cost components by claim_id; the composite FK is (attempt_id, claim_id)
    // so nothing led with claim_id before (YUK-452 review).
    index('placement_starter_cost_component_claim_idx').on(t.claim_id),
    check(
      'placement_starter_cost_component_kind_check',
      sql`${t.component_kind} IN ('quiz_gen','quiz_verify','solution_check','teaching_quality')`,
    ),
    check(
      'placement_starter_cost_component_nonnegative',
      sql`(
        ${t.provider_task_run_id} LIKE 'reservation:%'
        AND ${t.cost_micro_usd} IS NOT NULL
        AND ${t.cost_micro_usd} >= 0
      ) OR (
        ${t.provider_task_run_id} NOT LIKE 'reservation:%'
        AND (${t.cost_micro_usd} IS NULL OR ${t.cost_micro_usd} >= 0)
      )`,
    ),
    check(
      'placement_starter_cost_component_over_cap_check',
      sql`${t.over_cap} IS NULL OR (${t.provider_task_run_id} NOT LIKE 'reservation:%' AND ${t.cost_micro_usd} IS NOT NULL)`,
    ),
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
