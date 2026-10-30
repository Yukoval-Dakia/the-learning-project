// Platform operations: migration apply runs, contract epochs, system config
// lineage, and the prune/orphan control tables and receipts.

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// YUK-1050 — 历史迁移 apply 执行器的运行账本（grounding §15：分阶段离线可续跑
// + locks/WAL/duration 观测）。运维工具表，非判分/作答真相：允许 UPDATE（阶段
// 状态迁移）；真相源表自身的不可变性由 0105/0106/0107 trigger 保证，与本表无关。
// 备份语义（review P1-1）：运维态不进备份（BACKUP_EXCLUDED_TABLES）且 restore 时
// 先擦除（RESTORE_WIPE_ONLY_TABLES，子 phase 先于父 run）—— 残留旧 apply 进度
// 坐在恢复后的旧真相数据旁是错误的（会假装迁移已完成/未完成）。
export const migration_apply_run = pgTable(
  'migration_apply_run',
  {
    run_id: text('run_id').primaryKey(),
    checkpoint_hash: text('checkpoint_hash').notNull(),
    classification_hash: text('classification_hash').notNull(),
    classification_version: text('classification_version').notNull(),
    /** revision registry 工件 digest（无 registry 时 NULL）。 */
    registry_digest: text('registry_digest'),
    plan_digest: text('plan_digest').notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    wal_lsn_start: text('wal_lsn_start'),
    wal_lsn_end: text('wal_lsn_end'),
    error: text('error'),
  },
  (t) => [
    check('migration_apply_run_status_ck', sql`${t.status} IN ('running','completed','failed')`),
  ],
);

export const migration_apply_phase = pgTable(
  'migration_apply_phase',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => migration_apply_run.run_id),
    phase: text('phase', {
      enum: ['preflight', 'plan', 'apply_mappings', 'apply_submissions', 'reconcile'],
    }).notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'skipped'],
    }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    duration_ms: integer('duration_ms'),
    wal_lsn_start: text('wal_lsn_start'),
    wal_lsn_end: text('wal_lsn_end'),
    rows_written: integer('rows_written').notNull().default(0),
    rows_already_present: integer('rows_already_present').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('migration_apply_phase_run_phase_uq').on(t.run_id, t.phase),
    check(
      'migration_apply_phase_status_ck',
      sql`${t.status} IN ('running','completed','failed','skipped')`,
    ),
    check(
      'migration_apply_phase_name_ck',
      sql`${t.phase} IN ('preflight','plan','apply_mappings','apply_submissions','reconcile')`,
    ),
    check(
      'migration_apply_phase_rows_ck',
      sql`${t.rows_written} >= 0 AND ${t.rows_already_present} >= 0`,
    ),
  ],
);

// YUK-1055 — DB contract epoch marker（grounding §15：DB epoch
// `preparing/ready/active` 在 recovery/handlers/cron 之前建立，app/worker 契约
// guard 读它决定本进程能否执行 runtime 路径）。
//
// 设计：append-only history —— 一行 = 一次 epoch 状态迁移（全序 seq），「当前
// epoch」= seq 最大行。不用单行 UPDATE：迁移窗口的历史本身就是审计证据。
// 真相语义（src/server/contract-epoch/rules.ts 是唯一裁决者，本表只是存储）：
//   - 缺表/空表 = 隐式 (CODE_CONTRACT_EPOCH,'active') —— 无 marker 的 DB 对本代码
//     天然 runnable（pre-cutover 时期该隐式值是 'legacy'，翻转后随代码 epoch）。
//   - 'preparing'：维护窗口，全部 runtime 路径 fenced（含旧 epoch）。
//   - 'ready'：迁移已验证待激活，仍 fenced（安静窗口）。
//   - 'active'：仅当 marker.epoch 等于运行代码的 contract epoch 才 runnable。
// 备份语义：durable（非运维态）→ FK_ORDER，见 src/server/export/constants.ts。
export const contract_epoch = pgTable(
  'contract_epoch',
  {
    seq: integer('seq').primaryKey(),
    epoch: text('epoch').notNull(),
    state: text('state', { enum: ['preparing', 'ready', 'active'] }).notNull(),
    entered_at: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    /** 迁移操作者/工具标识（CLI --actor / 'migrate'）。 */
    entered_by: text('entered_by').notNull(),
    note: text('note'),
  },
  (t) => [
    check('contract_epoch_state_ck', sql`${t.state} IN ('preparing','ready','active')`),
    check('contract_epoch_epoch_nonempty_ck', sql`length(${t.epoch}) > 0`),
    check('contract_epoch_entered_by_nonempty_ck', sql`length(${t.entered_by}) > 0`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-1007 — 热加载配置面三表（grounding：
// docs/planning/2026-09-26-yuk1007-hot-reload-config.md §1）。
//
//   system_config         — per-key 行（registry 登记的 canonical key → jsonb 值
//                           + per-key revision 单调轴）。DB 是 app / worker 两进程
//                           唯一的共享媒介（无 Redis / IPC）。
//   system_config_journal — append-only 审计账本（subject_trait_journal 先例），
//                           (key, revision) PK；change_seq 取独立序列
//                           config_change_seq（不复用 subject_change_seq）。
//   system_config_epoch   — 单行失效轴（id='global'）：每次写 bump epoch，刷新侧
//                           先探测 epoch 相同即跳过全量 SELECT。
//
// 并发协议：与 subject 控制面不同，config 写面**不**取 advisory lock（§6.3：行级
// upsert + journal + epoch 同 tx，最后一次赢；单用户 admin 面）。restore 尾须
// setval('config_change_seq', max(change_seq)+1)（archive.ts）。
// ─────────────────────────────────────────────────────────────────────────────

export const system_config = pgTable('system_config', {
  // registry（src/core/config/registry.ts）登记的 canonical key。
  key: text('key').primaryKey(),
  // boolean | number | string | string[] | {provider?, model?, budget?}。
  value: jsonb('value').notNull(),
  // 每次写 +1（= journal 行的 revision 轴）。
  revision: integer('revision').notNull().default(0),
  // 自由备注（「谁为什么设」）。
  source_note: text('source_note'),
  // YUK-1557 — TEMP 覆盖必须能被时间收口：非空时该行只在此刻之前生效，
  // 过期后读面 fall through 到 env/code default（不删行，保留审计值）。
  expires_at: timestamp('expires_at', { withTimezone: true }),
  // 'panel:admin' | 'migrate' | 'cli' 等 actor 标签（枚举在写面 zod 侧，
  // DDL 保持 loose text —— 同 subject_control_journal.actor 惯例）。
  updated_by: text('updated_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const system_config_journal = pgTable(
  'system_config_journal',
  {
    key: text('key').notNull(),
    // = 该 key 主行写后 revision（clear 行 = prev.revision+1 占位）。
    revision: integer('revision').notNull(),
    // {prev, next, note} —— 完整快照语义同 subject_trait_journal。
    payload: jsonb('payload').notNull(),
    action: text('action', { enum: ['set', 'clear', 'seed'] }).notNull(),
    actor: text('actor').notNull(),
    // 独立序列 config_change_seq（不复用 subject_change_seq——两域独立）。
    // 序列不随行备份：restore 尾 setval（archive.ts）。
    change_seq: bigint('change_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('config_change_seq')`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.revision] })],
);

export const system_config_epoch = pgTable('system_config_epoch', {
  // 单行轴：恒 'global'。
  id: text('id').primaryKey(),
  // 每次写 +1（同 tx 内 nextval(config_change_seq) 供 journal 与 epoch 共用）。
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// YUK-1355: only the admitted housekeeping family can change recovery owner.
export const judge_run_control = pgTable(
  'judge_run_control',
  {
    id: smallint('id').primaryKey(),
    incarnation: uuid('incarnation').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    phase: text('phase').notNull(),
    phase_changed_at: timestamp('phase_changed_at', { withTimezone: true }).notNull(),
    transition_event_id: text('transition_event_id'),
  },
  (t) => [
    check('judge_run_control_singleton', sql`${t.id} = 1`),
    check('judge_run_control_epoch', sql`${t.epoch} >= 0`),
    check(
      'judge_run_control_phase',
      sql`${t.phase} IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')`,
    ),
  ],
);

export const prune_job_events_control = pgTable(
  'prune_job_events_control',
  {
    phase: text('phase').notNull(),
  },
  () => [uniqueIndex('prune_job_events_control_singleton').on(sql`(true)`)],
);

export const prune_job_events_receipt = pgTable('prune_job_events_receipt', {
  workflow_id: text('workflow_id').primaryKey(),
  cutoff: timestamp('cutoff', { withTimezone: true }).notNull(),
  deleted: integer('deleted').notNull(),
});

export const prune_job_events_disposition = pgTable(
  'prune_job_events_disposition',
  {
    backend: text('backend').notNull(),
    task_id: text('task_id').notNull(),
    observed_state: text('observed_state').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [primaryKey({ columns: [t.backend, t.task_id] })],
);

// YUK-1393: execution evidence belongs to full-DB recovery, never learner archives.
export const review_orphan_control = pgTable(
  'review_orphan_control',
  {
    phase: text('phase', {
      enum: ['pg-boss', 'draining-pg-boss', 'dbos', 'draining-dbos'],
    }).notNull(),
    phase_changed_at: timestamp('phase_changed_at', { withTimezone: true }).notNull().defaultNow(),
    legacy_not_before: timestamp('legacy_not_before', { withTimezone: true }),
  },
  () => [uniqueIndex('review_orphan_control_singleton').on(sql`(true)`)],
);

export const review_orphan_tick = pgTable('review_orphan_tick', {
  tick_id: text('tick_id').primaryKey(),
  backend: text('backend', { enum: ['pg-boss', 'dbos'] }).notNull(),
  provenance: text('provenance', { enum: ['scheduled', 'legacy-first-admission'] }).notNull(),
  tick_at: timestamp('tick_at', { withTimezone: true }).notNull(),
  cutoff: timestamp('cutoff', { withTimezone: true }).notNull(),
  admission: text('admission', { enum: ['admitted', 'fenced'] }).notNull(),
  candidates: jsonb('candidates')
    .$type<{ sessionId: string; selectedStartedAt: string; selectedVersion: number }[]>()
    .notNull(),
  contract_version: integer('contract_version').notNull(),
  recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const review_orphan_receipt = pgTable(
  'review_orphan_receipt',
  {
    tick_id: text('tick_id')
      .notNull()
      .references(() => review_orphan_tick.tick_id),
    session_id: text('session_id').notNull(),
    outcome: jsonb('outcome')
      .$type<
        | { kind: 'abandoned'; fromVersion: number; toVersion: number }
        | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'reopened' | 'not-old' }
        | { kind: 'deferred-known-failure'; error: string }
      >()
      .notNull(),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tick_id, t.session_id] })],
);

export const review_orphan_disposition = pgTable('review_orphan_disposition', {
  id: text('id').primaryKey(),
  backend: text('backend', { enum: ['pg-boss', 'dbos'] }).notNull(),
  task_id: text('task_id').notNull(),
  kind: text('kind', { enum: ['terminal', 'quiescence'] }).notNull(),
  observed_state: text('observed_state').notNull(),
  reason: text('reason').notNull(),
  recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

// YUK-1394: family-scoped execution evidence, restored only with the full database.
export const session_orphan_control = pgTable('session_orphan_control', {
  family: text('family', {
    enum: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'],
  }).primaryKey(),
  phase: text('phase', {
    enum: ['pg-boss', 'draining-pg-boss', 'dbos', 'draining-dbos'],
  }).notNull(),
  phase_changed_at: timestamp('phase_changed_at', { withTimezone: true }).notNull().defaultNow(),
  legacy_not_before: timestamp('legacy_not_before', { withTimezone: true }),
});

export const session_orphan_tick = pgTable(
  'session_orphan_tick',
  {
    family: text('family', {
      enum: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'],
    })
      .notNull()
      .references(() => session_orphan_control.family),
    tick_id: text('tick_id').notNull(),
    backend: text('backend', { enum: ['pg-boss', 'dbos'] }).notNull(),
    provenance: text('provenance', { enum: ['scheduled', 'legacy-first-admission'] }).notNull(),
    tick_at: timestamp('tick_at', { withTimezone: true }).notNull(),
    cutoff: timestamp('cutoff', { withTimezone: true }).notNull(),
    admission: text('admission', { enum: ['admitted', 'fenced'] }).notNull(),
    candidates: jsonb('candidates')
      .$type<import('../../server/durable/session-orphan-family').SessionOrphanTick['candidates']>()
      .notNull(),
    contract_version: integer('contract_version').notNull(),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.family, t.tick_id] })],
);

export const session_orphan_receipt = pgTable(
  'session_orphan_receipt',
  {
    family: text('family', {
      enum: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'],
    }).notNull(),
    tick_id: text('tick_id').notNull(),
    session_id: text('session_id').notNull(),
    outcome: jsonb('outcome')
      .$type<import('../../server/durable/session-orphan-family').SessionOrphanOutcome>()
      .notNull(),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.family, t.tick_id, t.session_id] }),
    foreignKey({
      columns: [t.family, t.tick_id],
      foreignColumns: [session_orphan_tick.family, session_orphan_tick.tick_id],
    }),
  ],
);

export const session_orphan_disposition = pgTable(
  'session_orphan_disposition',
  {
    family: text('family', {
      enum: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'],
    })
      .notNull()
      .references(() => session_orphan_control.family),
    id: text('id').notNull(),
    backend: text('backend', { enum: ['pg-boss', 'dbos'] }).notNull(),
    kind: text('kind', { enum: ['terminal-task', 'terminal-row', 'quiescence'] }).notNull(),
    observed_state: text('observed_state').notNull(),
    reason: text('reason').notNull(),
    task_id: text('task_id'),
    tick_id: text('tick_id'),
    session_id: text('session_id'),
    barrier_at: timestamp('barrier_at', { withTimezone: true }),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.family, t.id] }),
    foreignKey({
      columns: [t.family, t.tick_id],
      foreignColumns: [session_orphan_tick.family, session_orphan_tick.tick_id],
    }),
  ],
);
