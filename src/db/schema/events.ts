// Event sourcing and queues: the event log, subscription checkpoints,
// deliveries and effects, projections (materialized id index, proposal
// signals), job events, and DAG orchestration.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
import { artifact } from './artifacts';

type JsonObject = Record<string, unknown>;

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

export const event = pgTable(
  'event',
  {
    id: text('id').primaryKey(),
    // YUK-751 — insertion-order diagnostic/tie-break coordinate. This sequence is
    // never a subscription completeness cursor; delivery rows own subscriber-local order.
    // mode:'number' (NOT 'bigint' like `generation`): in the subscription runtime dispatch_seq never
    // crosses into app code — bootstrap + discovery mark/allocate it entirely in set-based SQL
    // (INSERT … SELECT), so no JS `number` read of it exists (TdYuL/TdYuZ). The peer subscription seq
    // columns that ARE read raw (delivery_seq / next_delivery_seq via `tx.execute`) are typed `string`
    // — postgres parses bigint as a decimal string — and normalized through asBigint(); the
    // handler-facing boundary serializes to a decimal string (manifest
    // EventSubscriptionDelivery.deliverySeq). So no JS `number` truncation path exists; the bigint-mode
    // rationale that applies to `generation` (read via the query builder) does not apply here.
    dispatch_seq: bigint('dispatch_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('event_dispatch_seq')`),
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
    // 'success' | 'failure' | 'partial' | 'degraded' | NULL (depends on action)
    outcome: text('outcome'),
    // Zod-guarded per (action × subject_kind) — see Lane B
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    // chain link: judge ← attempt, propose ← cron, etc.
    caused_by_event_id: text('caused_by_event_id'),
    // ADR-0017 brief writer scope tags; fixed prefixes, dynamic suffixes.
    affected_scopes: text('affected_scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    // AI task run association. Intentional loose coupling — NO hard FK to
    // ai_task_runs.id: task_run_id is nullable and is often written before the
    // ai_task_runs row exists (or for events with no run at all), so a real FK
    // would break INSERTs. Treated as a free-form text correlation id.
    task_run_id: text('task_run_id'),
    cost_micro_usd: integer('cost_micro_usd'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // YUK-101 / ADR-0021 — transactional outbox cursor. `writeEvent` only
    // INSERTs the row (ADR-0005 single-owner invariant); a separate poll
    // handler in `src/server/memory/triggers.ts` picks pending rows
    // (`ingest_at IS NULL`) with SELECT…FOR UPDATE SKIP LOCKED, enqueues
    // `memory_event_ingest`, and stamps `ingest_at = now()` in the same tx.
    // The partial index `event_ingest_pending_idx` keeps the pending scan
    // cheap regardless of total event volume.
    ingest_at: timestamp('ingest_at', { withTimezone: true }),
  },
  (t) => [
    index('event_subject_idx').on(t.subject_kind, t.subject_id, t.created_at.desc()),
    index('event_action_outcome_idx').on(t.action, t.outcome, t.created_at.desc()),
    index('event_session_idx').on(t.session_id, t.created_at),
    index('event_actor_idx').on(t.actor_kind, t.actor_ref, t.created_at),
    index('event_caused_by_idx').on(t.caused_by_event_id),
    uniqueIndex('event_id_dispatch_seq_unique').on(t.id, t.dispatch_seq),
    uniqueIndex('event_dispatch_seq_unique').on(t.dispatch_seq),
    index('event_action_dispatch_idx').on(t.action, t.dispatch_seq, t.id),
    index('event_affected_scopes_idx').using('gin', t.affected_scopes),
    // YUK-101 — partial index for the outbox poll handler. Declared in
    // hand-written migration drizzle/0017_outbox_event_ingest.sql because
    // drizzle-kit doesn't generate partial-index `WHERE …` clauses natively
    // at this version.
    // GIN index `event_payload_idx` on payload (jsonb_path_ops) — declared in hand-written
    // migration (drizzle-kit doesn't generate GIN on jsonb_path_ops natively at this version).
    // See drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql. This is the index the
    // W3 question_block merge gather's top-level `payload @> {affected_blocks:[{block_id}]}`
    // containment (gather.ts gatherAndFoldQuestionBlock Q2) relies on (YUK-471 W3-C0).
  ],
);

// YUK-751 — derived operational recovery state for manifest-declared subscribers.
// There is deliberately no source high-water cursor: discovery anti-joins the immutable event log
// against delivery rows, while next_delivery_seq orders each subscriber's durable local work.
export const event_subscription_checkpoint = pgTable(
  'event_subscription_checkpoint',
  {
    subscriber_id: text('subscriber_id').notNull(),
    subscriber_version: integer('subscriber_version').notNull(),
    declaration_hash: text('declaration_hash').notNull(),
    status: text('status', { enum: ['bootstrapping', 'active', 'paused'] }).notNull(),
    next_delivery_seq: bigint('next_delivery_seq', { mode: 'number' }).notNull().default(1),
    claim_owner: text('claim_owner'),
    claim_token: uuid('claim_token'),
    claim_lease_until: timestamp('claim_lease_until', { withTimezone: true }),
    bootstrapped_at: timestamp('bootstrapped_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    // YUK-1113: historical SQL/archive compatibility only; no business timestamp producer.
    // Keep this property so typed export/restore preserves existing values (including null).
    paused_at: timestamp('paused_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriber_id, t.subscriber_version] }),
    check('event_subscription_checkpoint_version_positive', sql`${t.subscriber_version} > 0`),
    check('event_subscription_checkpoint_delivery_seq_positive', sql`${t.next_delivery_seq} > 0`),
    check(
      'event_subscription_checkpoint_status_check',
      sql`${t.status} IN ('bootstrapping','active','paused')`,
    ),
    check(
      'event_subscription_checkpoint_claim_shape',
      sql`(${t.claim_owner} IS NULL AND ${t.claim_token} IS NULL AND ${t.claim_lease_until} IS NULL)
        OR (${t.claim_owner} IS NOT NULL AND ${t.claim_token} IS NOT NULL AND ${t.claim_lease_until} IS NOT NULL)`,
    ),
    index('event_subscription_checkpoint_status_idx').on(t.status, t.updated_at),
    index('event_subscription_checkpoint_expired_lease_idx')
      .on(t.claim_lease_until, t.subscriber_id, t.subscriber_version)
      .where(sql`${t.claim_lease_until} IS NOT NULL`),
  ],
);

export const event_subscription_delivery = pgTable(
  'event_subscription_delivery',
  {
    subscriber_id: text('subscriber_id').notNull(),
    subscriber_version: integer('subscriber_version').notNull(),
    source_event_id: text('source_event_id').notNull(),
    source_dispatch_seq: bigint('source_dispatch_seq', { mode: 'number' }).notNull(),
    delivery_seq: bigint('delivery_seq', { mode: 'number' }).notNull(),
    status: text('status', {
      enum: [
        'bootstrap_skipped',
        'pending',
        'claimed',
        'retry_wait',
        'succeeded',
        'skipped',
        'dead_letter',
      ],
    }).notNull(),
    attempt_count: integer('attempt_count').notNull().default(0),
    redrive_count: integer('redrive_count').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    claim_owner: text('claim_owner'),
    claim_token: uuid('claim_token'),
    claim_lease_until: timestamp('claim_lease_until', { withTimezone: true }),
    last_error: text('last_error'),
    outcome: jsonb('outcome').$type<JsonObject>(),
    discovered_at: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriber_id, t.subscriber_version, t.source_event_id] }),
    foreignKey({
      columns: [t.source_event_id, t.source_dispatch_seq],
      foreignColumns: [event.id, event.dispatch_seq],
      name: 'event_subscription_delivery_source_event_fk',
    }),
    foreignKey({
      columns: [t.subscriber_id, t.subscriber_version],
      foreignColumns: [
        event_subscription_checkpoint.subscriber_id,
        event_subscription_checkpoint.subscriber_version,
      ],
      name: 'event_subscription_delivery_checkpoint_fk',
    }),
    uniqueIndex('event_subscription_delivery_local_seq_uq').on(
      t.subscriber_id,
      t.subscriber_version,
      t.delivery_seq,
    ),
    check('event_subscription_delivery_version_positive', sql`${t.subscriber_version} > 0`),
    check('event_subscription_delivery_seq_positive', sql`${t.delivery_seq} > 0`),
    check('event_subscription_delivery_attempt_nonnegative', sql`${t.attempt_count} >= 0`),
    check('event_subscription_delivery_redrive_nonnegative', sql`${t.redrive_count} >= 0`),
    check(
      'event_subscription_delivery_status_check',
      sql`${t.status} IN ('bootstrap_skipped','pending','claimed','retry_wait','succeeded','skipped','dead_letter')`,
    ),
    check(
      'event_subscription_delivery_claim_shape',
      sql`((${t.claim_owner} IS NULL AND ${t.claim_token} IS NULL AND ${t.claim_lease_until} IS NULL AND ${t.claimed_at} IS NULL)
        OR (${t.claim_owner} IS NOT NULL AND ${t.claim_token} IS NOT NULL AND ${t.claim_lease_until} IS NOT NULL AND ${t.claimed_at} IS NOT NULL))
        AND ((${t.status} = 'claimed') = (${t.claim_owner} IS NOT NULL))`,
    ),
    check(
      'event_subscription_delivery_retry_shape',
      sql`((${t.status} = 'retry_wait') = (${t.next_attempt_at} IS NOT NULL))`,
    ),
    check(
      'event_subscription_delivery_completion_shape',
      sql`((${t.status} IN ('bootstrap_skipped','succeeded','skipped','dead_letter')) = (${t.completed_at} IS NOT NULL))`,
    ),
    index('event_subscription_delivery_ready_idx')
      .on(t.subscriber_id, t.subscriber_version, t.delivery_seq)
      .where(sql`${t.status} IN ('pending','retry_wait')`),
    index('event_subscription_delivery_expired_claim_idx')
      .on(t.claim_lease_until, t.subscriber_id, t.subscriber_version, t.delivery_seq)
      .where(sql`${t.status} = 'claimed'`),
    index('event_subscription_delivery_dlq_idx')
      .on(t.subscriber_id, t.subscriber_version, t.completed_at.desc())
      .where(sql`${t.status} = 'dead_letter'`),
    index('event_subscription_delivery_history_idx').on(
      t.subscriber_id,
      t.subscriber_version,
      t.delivery_seq.desc(),
    ),
    index('event_subscription_delivery_discovery_idx').on(
      t.subscriber_id,
      t.subscriber_version,
      t.source_dispatch_seq,
      t.source_event_id,
    ),
  ],
);

export const event_subscription_effect = pgTable(
  'event_subscription_effect',
  {
    id: text('id').primaryKey(),
    attempt_event_id: text('attempt_event_id')
      .notNull()
      .references(() => event.id),
    artifact_id: text('artifact_id')
      .notNull()
      .references(() => artifact.id),
    effect_kind: text('effect_kind', { enum: ['mastery_change'] }).notNull(),
    subscriber_id: text('subscriber_id'),
    subscriber_version: integer('subscriber_version'),
    source_event_id: text('source_event_id'),
    mastery_event_ids: text('mastery_event_ids').array().notNull(),
    evidence_ids: text('evidence_ids').array().notNull(),
    question_id: text('question_id'),
    status: text('status', { enum: ['reserved', 'enqueued', 'debounced', 'disabled'] }).notNull(),
    stable_job_key: text('stable_job_key').notNull(),
    downstream_job_id: text('downstream_job_id'),
    reserved_at: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    enqueued_at: timestamp('enqueued_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    outcome: jsonb('outcome').$type<JsonObject>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('event_subscription_effect_causal_uq').on(
      t.attempt_event_id,
      t.artifact_id,
      t.effect_kind,
    ),
    uniqueIndex('event_subscription_effect_stable_job_key_uq').on(t.stable_job_key),
    foreignKey({
      columns: [t.subscriber_id, t.subscriber_version, t.source_event_id],
      foreignColumns: [
        event_subscription_delivery.subscriber_id,
        event_subscription_delivery.subscriber_version,
        event_subscription_delivery.source_event_id,
      ],
      name: 'event_subscription_effect_delivery_fk',
    }),
    check('event_subscription_effect_kind_check', sql`${t.effect_kind} = 'mastery_change'`),
    check(
      'event_subscription_effect_status_check',
      sql`${t.status} IN ('reserved','enqueued','debounced','disabled')`,
    ),
    check(
      'event_subscription_effect_provenance_shape',
      sql`(${t.subscriber_id} IS NULL AND ${t.subscriber_version} IS NULL AND ${t.source_event_id} IS NULL)
        OR (${t.subscriber_id} IS NOT NULL AND ${t.subscriber_version} IS NOT NULL AND ${t.subscriber_version} > 0 AND ${t.source_event_id} IS NOT NULL)`,
    ),
    check(
      'event_subscription_effect_mastery_events_nonempty',
      sql`cardinality(${t.mastery_event_ids}) > 0`,
    ),
    check('event_subscription_effect_evidence_nonempty', sql`cardinality(${t.evidence_ids}) > 0`),
    index('event_subscription_effect_recent_enqueued_idx')
      .on(t.artifact_id, t.effect_kind, t.enqueued_at.desc())
      .where(sql`${t.status} = 'enqueued'`),
    index('event_subscription_effect_provenance_idx').on(
      t.subscriber_id,
      t.subscriber_version,
      t.source_event_id,
    ),
    index('event_subscription_effect_downstream_job_idx')
      .on(t.downstream_job_id)
      .where(sql`${t.downstream_job_id} IS NOT NULL`),
  ],
);

// YUK-471 W1 PR-A2a — the A2 reverse-index (owner fork (a)): materialized id → anchor event.
//
// WHY THIS EXISTS. The W1 fold reducers (foldKnowledgeNode / foldKnowledgeEdge) replay
// the `event` log to project a node/edge row. Most mutations key on the event's own
// `subject_id` (reparent/archive/merge/auto_tag → subject_id IS the node id; all edge
// events → subject_id IS the edge id). But two CREATE shapes mint a node id that is NOT
// the event subject_id: `propose_new` (subject_id = the PROPOSAL id; the created node id
// is minted at accept and recorded in the accepting RATE's payload.materialized_ids
// .knowledge[0]) and `split` (subject_id = the source node; the new node ids live in the
// accepting RATE's materialized_ids.knowledge, ordered to match payload.into[]). To fold a
// node BY its id, the IO shell therefore needs an explicit id → anchor-event path. This
// reverse index supplies it: materialized_id → the propose/split event (post-keystone) or
// the genesis event (backfill) whose accept/seed materialized that id.
//
// HOW IT IS POPULATED. It is itself a tiny projection of the event log, written in two
// places, both behavior-preserving until the SoT flip:
//   - same-tx at accept-time (PR-A2b): when acceptProposal materializes a node id, it
//     upserts (materialized_id, anchor_event_id) inside the SAME transaction as the RATE
//     write, so the index never lags the log.
//   - at genesis-backfill-time (PR-A2a script): the backfill seeds one genesis event per
//     pre-event-sourcing row and upserts its id → genesis-event anchor here.
// PR-A2a only ADDS this table + the IO shells + the backfill/audit scripts; nothing on the
// live write path writes here yet (no double-write, no SoT flip — that is PR-A2b / PR-B).
//
// CHECK. `pnpm ops:projection` validates the knowledge / knowledge_edge projections, NOT
// this index directly (it scans only those two tables). The index is validated INDIRECTLY: a
// wrong/missing entry makes the node shell's Q2 reverse-index path resolve the wrong anchor
// (or none), so fold(events) for that id diverges from the live row and ops:projection flags
// it as drift. A dedicated index-vs-log audit is a possible future enhancement (not built).
export const materialized_id_index = pgTable(
  'materialized_id_index',
  {
    // the knowledge.id / knowledge_edge.id this row anchors. Minted exactly once, so it is
    // the natural PK (one anchor per materialized id).
    materialized_id: text('materialized_id').primaryKey(),
    // the propose/split event (post-keystone) OR genesis event (backfill) whose accept/seed
    // materialized `materialized_id`. The fold starts its replay from here.
    anchor_event_id: text('anchor_event_id').notNull(),
    // 'knowledge' | 'knowledge_edge' | 'goal' — which fold consumes this anchor (bare text, no
    // DB enum, so YUK-471 W2's 'goal' addition needs no migration). Mirrors MaterializedSubjectKind.
    subject_kind: text('subject_kind').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // reverse lookup: an anchor event can materialize several ids (split mints N nodes; a
    // genesis-backfill batch shares context) — index the FK side so "ids anchored by event X"
    // is cheap for the audit re-derivation.
    index('materialized_id_index_anchor_idx').on(t.anchor_event_id),
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

// ─────────────────────────────────────────────────────────────────────────────
// YUK-758 — 夜间任务编排 DAG 运行态（控制面调度记录）。
//
// 立意：夜链任务的触发从「钟表错峰」搬进 manifest 声明的 DAG（JobDecl.dependsOn），
// 由单锚点 orchestrator 驱动「上游成功才触发下游」。这两张表是 orchestrator 的**调度
// 态物理隔离面**——绝不进 event 数据面（控制面/数据面分离是立票红线）。纯瞬态运维态：
// 丢了下一夜 run 自然重建，故进 BACKUP_EXCLUDED_TABLES 非 FK_ORDER（无 SCHEMA_VERSION
// bump）。软引用（run_id / job_name / boss_job_id 皆 text-ref，无 enforced FK，沿仓库
// loose-coupling 惯例）。
// ─────────────────────────────────────────────────────────────────────────────

export const dag_orchestration_run = pgTable(
  'dag_orchestration_run',
  {
    id: text('id').primaryKey(),
    // run 归属的本地日（YYYY-MM-DD，Asia/Shanghai）。一日至多一条 active（running）run。
    run_date: text('run_date').notNull(),
    // 触发来源：'cron'（锚点 cron 开闸）| 'manual'（手动整链重跑）。
    trigger: text('trigger', { enum: ['cron', 'manual'] }).notNull(),
    // running（推进中）| completed（全节点终态）| abandoned（被新 run 顶替 / 超期收尾）。
    status: text('status', { enum: ['running', 'completed', 'abandoned'] }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // 单飞：一日至多一条 running run（DB 层兜住 cron 与 manual 撞车 / 双 worker 竞态）。
    uniqueIndex('dag_orchestration_run_active_per_day_uq')
      .on(t.run_date)
      .where(sql`status = 'running'`),
    index('dag_orchestration_run_status_idx').on(t.status),
    // DB 层枚举守卫（YUK-758 review ToTaI，仿 question_generation_plan_status_ck）：
    // 单飞 partial unique 依赖 status='running'，坏 status 值会静默绕过——CHECK 兜住。
    check('dag_orchestration_run_trigger_ck', sql`${t.trigger} IN ('cron','manual')`),
    check(
      'dag_orchestration_run_status_ck',
      sql`${t.status} IN ('running','completed','abandoned')`,
    ),
  ],
);

export const dag_orchestration_node = pgTable(
  'dag_orchestration_node',
  {
    id: text('id').primaryKey(),
    // 归属 run。**enforced FK + ON DELETE CASCADE**（YUK-758 review ToTvQ）：没有约束时可以写入
    // 指向不存在 run 的节点行，这类孤儿既不被任何 run 管理、也不会被推进或恢复，且 restore/
    // reset 的按表清理也未必覆盖到。CASCADE 让「删一条 run」自动带走其节点（与
    // RESTORE_WIPE_ONLY_TABLES 的 node→run 顺序一致，二者互不冲突）。
    run_id: text('run_id')
      .notNull()
      .references(() => dag_orchestration_run.id, { onDelete: 'cascade' }),
    // 图成员 job 名（= boss 队列名 = JobDecl.name）。
    job_name: text('job_name').notNull(),
    // pending（未就绪）| enqueued（已 boss.send，等 pg-boss 消费）| running（pg-boss active）|
    // succeeded | failed | skipped（硬上游失败/跳过 → 本节点不跑）|
    // not_needed（资格判定不跑）| degraded（试过且零成功）。后两者是软终态。
    status: text('status', {
      enum: [
        'pending',
        'enqueued',
        'running',
        'succeeded',
        'failed',
        'skipped',
        'not_needed',
        'degraded',
      ],
    }).notNull(),
    // enqueue 后回填的 pg-boss job id（轮询终态用 boss.getJobById）。
    boss_job_id: text('boss_job_id'),
    // 是否带 stale 入队（软上游未成功但硬上游齐 → 照跑并在 job payload 标 stale:true）。
    stale: boolean('stale').notNull().default(false),
    // skipped/failed 的可读原因（观测痕迹，如 "upstream 'x' failed"）。
    detail: text('detail'),
    enqueued_at: timestamp('enqueued_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // 每 run 每 job 恰一节点行（幂等推进的锚）。
    uniqueIndex('dag_orchestration_node_run_job_uq').on(t.run_id, t.job_name),
    // 推进扫描：按 run 取某状态的节点。
    index('dag_orchestration_node_run_status_idx').on(t.run_id, t.status),
    // DB 层枚举守卫（YUK-758 review ToTaI）：CAS 转移/终态守卫皆以 status 字面为条件，
    // 坏值会破坏推进不变量——CHECK 兜住。
    check(
      'dag_orchestration_node_status_ck',
      sql`${t.status} IN ('pending','enqueued','running','succeeded','failed','skipped','not_needed','degraded')`,
    ),
  ],
);
