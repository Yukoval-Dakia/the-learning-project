// Assessment contract source of truth: immutable question revisions, group
// lifecycle, admissions, issuance, submissions, evaluations, effective heads,
// and historical identity mapping.

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type {
  AdmissionEvidenceT,
  AggregateOutcomeT,
  ExecutionPlanT,
  GroupEvidenceT,
  IssuedMaterialBindingT,
  IssuedOptionOrderT,
  PresentationT,
  QuestionGroupStructureT,
  ResponseSetT,
  ResponseSpecT,
  ScoringBasisT,
  ScoringUnitResultT,
} from '../../core/schema/assessment';
import type { AgentRef } from '../../core/schema/business';

type AgentRefT = z.infer<typeof AgentRef>;
type JsonObject = Record<string, unknown>;

// ====================================================================
// YUK-1044 — 统一评估契约真相源（grounding §3、§11；契约类型见
// src/core/schema/assessment（YUK-1046））。DDL-only：本票只建真相源表，
// 不新增任何写路径（写者归 producer/evaluator lanes）；旧 question 平面列
// 保留为只读投影与回滚资产 —— 无原始内容双写设计（§3.1）。
//
// Restore 通道（0105/0107，见 archive.ts）：不可变 guard（本块四表的 BEFORE
// UPDATE/DELETE trigger）在 `SET LOCAL app.assessment_restore_mode = 'on'` 的
// 恢复事务内放行 wipe+重插；GUC 随事务结束自动失效，普通 writer 的拒结名单
// 逐字节不变。九表全部入 backup FK_ORDER（SCHEMA_VERSION 4.21）。
// ====================================================================

/**
 * 不可变发布版本：属于 group root（单题 = 1-part 组）。唯一键
 * (group_id, revision_ordinal) —— 不是全局内容 hash（§3.1）。
 * integrity_digest 覆盖材料/资产 digest、内容、作答契约、评分依据与执行
 * 计划引用，永不因 archive 改变（§3.2）。无 updated_at：行一旦写入不可变
 * （DB 层由 BEFORE UPDATE/DELETE trigger 拒绝改写/删除，见 0105 迁移 ——
 * 缺 updated_at 本身不构成不可变性）；修正 = 新 revision + supersedes 链，
 * 历史提交仍绑定原版（§3.3 表）。
 * availability 在发布时选定副本（scope 快照）；可变生命周期在
 * question_group_lifecycle。
 */
export const question_revision = pgTable(
  'question_revision',
  {
    revision_id: text('revision_id').primaryKey(),
    group_id: text('group_id').notNull(),
    revision_ordinal: integer('revision_ordinal').notNull(),
    integrity_digest: text('integrity_digest').notNull(),
    structure: jsonb('structure').$type<QuestionGroupStructureT>().notNull(),
    response_spec: jsonb('response_spec').$type<ResponseSpecT>().notNull(),
    scoring_basis: jsonb('scoring_basis').$type<ScoringBasisT>().notNull(),
    execution_plan: jsonb('execution_plan').$type<ExecutionPlanT>().notNull(),
    // YUK-1497 — 冻结公开展示层（blocks-v1）。可空：旧 revision 无此层；
    // 含此层的行在发布时已过 validatePresentation 并计入 integrity_digest。
    presentation: jsonb('presentation').$type<PresentationT>(),
    supersedes_revision_id: text('supersedes_revision_id'),
    availability: text('availability', {
      enum: ['general_pool', 'container_only'],
    }).notNull(),
    published_by: jsonb('published_by').$type<AgentRefT>(),
    published_at: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('question_revision_group_ordinal_uq').on(t.group_id, t.revision_ordinal),
    index('question_revision_integrity_digest_idx').on(t.integrity_digest),
    // 复合 FK 目标：lifecycle current pointer 必须 (group, revision) 同组一致（P1-2）。
    uniqueIndex('question_revision_group_id_uq').on(t.group_id, t.revision_id),
    check(
      'question_revision_availability_ck',
      sql`${t.availability} IN ('general_pool','container_only')`,
    ),
    check('question_revision_ordinal_positive_ck', sql`${t.revision_ordinal} >= 1`),
  ],
);

/**
 * group root 的可变生命周期权威（§3.2/§3.3）—— draft_status 语义拆分后的
 * 独立维度落位：current pointer / pool-vs-container / 评分准入（含 generation）/
 * claim 政策 / 挂起 / 撤回。新 revision、current pointer 与发布事件同事务
 * 提交（§3.1）；archive 释放 live 去重 claim，不清除历史摘要/绑定。
 */
export const question_group_lifecycle = pgTable(
  'question_group_lifecycle',
  {
    group_id: text('group_id').primaryKey(),
    current_revision_id: text('current_revision_id'),
    availability: text('availability', {
      enum: ['general_pool', 'container_only'],
    }).notNull(),
    scoring_admission_state: text('scoring_admission_state', {
      enum: ['admitted', 'withheld'],
    }).notNull(),
    scoring_admission_evidence: jsonb('scoring_admission_evidence').$type<AdmissionEvidenceT>(),
    scoring_admission_generation: integer('scoring_admission_generation').notNull().default(0),
    // P2-C：withheld 分支的显式原因（admitted 分支为 NULL，CHECK 强制分支完整性）。
    scoring_admission_withheld_reason: text('scoring_admission_withheld_reason', {
      enum: ['unverified_rules', 'verification_failed', 'no_admitted_executor', 'owner_hold'],
    }),
    // P2-C：admission 决定时间戳（admitted 分支必填；evidence 列同支必填）。
    scoring_admission_decided_at: timestamp('scoring_admission_decided_at', {
      withTimezone: true,
    }),
    claim_policy: text('claim_policy', {
      enum: ['one_time', 'unbounded'],
    }).notNull(),
    suspended: boolean('suspended').notNull().default(false),
    suspension_reason: text('suspension_reason', {
      enum: ['verify_hold', 'retraction_hold'],
    }),
    withdrawn: boolean('withdrawn').notNull().default(false),
    withdrawn_at: timestamp('withdrawn_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('question_group_lifecycle_current_revision_idx').on(t.current_revision_id),
    // P1-2：current pointer 必须 (group, revision) 同组一致 —— 复合 FK 拒绝指向他组 revision。
    foreignKey({
      columns: [t.group_id, t.current_revision_id],
      foreignColumns: [question_revision.group_id, question_revision.revision_id],
      name: 'question_group_lifecycle_current_revision_fk',
    }),
    check(
      'question_group_lifecycle_availability_ck',
      sql`${t.availability} IN ('general_pool','container_only')`,
    ),
    check(
      'question_group_lifecycle_admission_state_ck',
      sql`${t.scoring_admission_state} IN ('admitted','withheld')`,
    ),
    check(
      'question_group_lifecycle_claim_policy_ck',
      sql`${t.claim_policy} IN ('one_time','unbounded')`,
    ),
    check(
      'question_group_lifecycle_suspension_reason_ck',
      sql`${t.suspension_reason} IN ('verify_hold','retraction_hold')`,
    ),
    check(
      'question_group_lifecycle_withheld_reason_ck',
      sql`${t.scoring_admission_withheld_reason} IN ('unverified_rules','verification_failed','no_admitted_executor','owner_hold')`,
    ),
    check(
      'question_group_lifecycle_admission_generation_ck',
      sql`${t.scoring_admission_generation} >= 0`,
    ),
    // P2-C：分支完整性 —— admitted 必须有决定时间与证据；withheld 必须有原因。
    check(
      'question_group_lifecycle_admission_branch_ck',
      sql`(${t.scoring_admission_state} = 'withheld' OR (${t.scoring_admission_decided_at} IS NOT NULL AND ${t.scoring_admission_evidence} IS NOT NULL)) AND (${t.scoring_admission_state} = 'admitted' OR ${t.scoring_admission_withheld_reason} IS NOT NULL)`,
    ),
  ],
);

/**
 * 新式 verify 记录（§3.3）：保存 (revision_id, digest, policy, generation)。
 * append-only —— DB 层由 BEFORE UPDATE/DELETE trigger 拒绝改写/删除（0105）；
 * 旧验证可留证据，但不能改变新 revision 或较新 admission 决定；
 * 复核/解除通过追加新记录表达，绝不 UPDATE 旧行。
 */
export const question_admission_verification = pgTable(
  'question_admission_verification',
  {
    id: text('id').primaryKey(),
    revision_id: text('revision_id').notNull(),
    revision_digest: text('revision_digest').notNull(),
    policy_id: text('policy_id').notNull(),
    generation: integer('generation').notNull(),
    outcome: text('outcome', {
      enum: ['passed', 'suspended', 'failed'],
    }).notNull(),
    evidence: jsonb('evidence').$type<JsonObject>().notNull().default({}),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('question_admission_verification_revision_idx').on(t.revision_id, t.generation),
    foreignKey({
      columns: [t.revision_id],
      foreignColumns: [question_revision.revision_id],
      name: 'question_admission_verification_revision_fk',
    }),
    check(
      'question_admission_verification_outcome_ck',
      sql`${t.outcome} IN ('passed','suspended','failed')`,
    ),
    check('question_admission_verification_generation_ck', sql`${t.generation} >= 0`),
  ],
);

/**
 * YUK-1496 C2 — 模型判分准入切片登记处（统一设计 §4 准入门第 4 步 / ADR-0073
 * D2「每科 ≥30 留出题的模型级准入」）。每一行 = 一个 (subject, response_class,
 * task_kind, model, model_version) 切片经留出题实测后的准入事实，证据引用
 * holdout_evidence_ref 指向逐题一致性记录（事件 id）。注册是显式 admin/worker
 * 动作（model_slice_admission_run 或人工），dry run 不落行；退役经显式
 * status='retired'，绝不物理删除（准入史实保留）。服务门只读 active 行。
 */
export const model_admission_slice = pgTable(
  'model_admission_slice',
  {
    slice_id: text('slice_id').primaryKey(),
    subject: text('subject').notNull(),
    response_class: text('response_class', { enum: ['blank', 'free'] }).notNull(),
    /** 注册的判分 task kind（typed task，如 JevScoringDecisionTask）。 */
    task_kind: text('task_kind').notNull(),
    /** 准入时实测的模型（请求 pin，如 typesafe/jev-1.13 / mimo-v2.5）。 */
    model: text('model').notNull(),
    /** 判分契约版本（typed：canonical 响应模型；chat：prompt 模板修订）。 */
    model_version: text('model_version').notNull(),
    /** 留出题实测证据引用（逐题 agreement / severe error 记录的事件 id）。 */
    holdout_evidence_ref: text('holdout_evidence_ref').notNull(),
    admitted_by: text('admitted_by').notNull(),
    admitted_at: timestamp('admitted_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['active', 'retired'] })
      .notNull()
      .default('active'),
  },
  (t) => [
    index('model_admission_slice_lookup_idx').on(t.subject, t.response_class, t.task_kind),
    uniqueIndex('model_admission_slice_natural_key').on(
      t.subject,
      t.response_class,
      t.task_kind,
      t.model,
      t.model_version,
    ),
    check('model_admission_slice_response_class_ck', sql`${t.response_class} IN ('blank','free')`),
    check('model_admission_slice_status_ck', sql`${t.status} IN ('active','retired')`),
  ],
);

/**
 * 发题（serve-time binding，§3.1）：发题时冻结 revision、目标 part、实际
 * 材料 digest 与选项呈现映射 —— 提交时不得再取 latest。claim 状态在此行
 * （one_time 用于诊断/probe/教学一次性占用；§3.3）。
 * P1-1：绑定列（revision/parts/materials/order/container_ref/issued_at +
 * claim_policy —— policy 是发题时选定的 serve 契约一部分，事后改会变更
 * claim 语义，同样冻结）由 BEFORE UPDATE trigger 冻结 —— 只有 claim 生命周期
 * 列（claim_status/claimed_by_ref）可变；DELETE 一律拒绝（发题事实是
 * 永久 serve 记录，见 0105/0106 迁移）。
 */
export const assessment_issuance = pgTable(
  'assessment_issuance',
  {
    issuance_id: text('issuance_id').primaryKey(),
    revision_id: text('revision_id').notNull(),
    part_ids: jsonb('part_ids').$type<string[]>().notNull(),
    material_bindings: jsonb('material_bindings')
      .$type<IssuedMaterialBindingT[]>()
      .notNull()
      .default([]),
    option_order: jsonb('option_order').$type<IssuedOptionOrderT[]>().notNull().default([]),
    container_occurrence_ref: text('container_occurrence_ref'),
    claim_policy: text('claim_policy', {
      enum: ['one_time', 'unbounded'],
    }).notNull(),
    claim_status: text('claim_status', {
      enum: ['unclaimed', 'claimed', 'released'],
    }).notNull(),
    claimed_by_ref: text('claimed_by_ref'),
    issued_at: timestamp('issued_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('assessment_issuance_revision_idx').on(t.revision_id),
    index('assessment_issuance_container_ref_idx').on(t.container_occurrence_ref),
    foreignKey({
      columns: [t.revision_id],
      foreignColumns: [question_revision.revision_id],
      name: 'assessment_issuance_revision_fk',
    }),
    // P1-2：作为 submission 复合 FK 目标 —— (issuance, revision) 冗余坐标必须一致。
    uniqueIndex('assessment_issuance_id_revision_uq').on(t.issuance_id, t.revision_id),
    check(
      'assessment_issuance_claim_policy_ck',
      sql`${t.claim_policy} IN ('one_time','unbounded')`,
    ),
    check(
      'assessment_issuance_claim_status_ck',
      sql`${t.claim_status} IN ('unclaimed','claimed','released')`,
    ),
  ],
);

/**
 * 联合判分组：一次 settle 的单位（solo 单题 = 单 submission 组）。
 *
 * P1（YUK-1097）：submission_ids 是成员关系的 DB 层派生缓存 ——
 * submission INSERT trigger 追加成员；组行 UPDATE 只允许严格前缀追加
 * 真实成员（移除/重排/幻影/尾重复拒绝），DELETE 一律拒绝（0111
 * trigger）。INSERT 侧 declare-first：可声明尚不存在的成员（计划模式），
 * 兑现一致性由迁移批内容对账覆盖。
 */
export const evaluation_group = pgTable(
  'evaluation_group',
  {
    evaluation_group_id: text('evaluation_group_id').primaryKey(),
    submission_ids: jsonb('submission_ids').$type<string[]>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // 空组无意义：至少一个 submission 才能结算（DB 层兑底，app 层仍先校验）。
    check(
      'evaluation_group_submission_ids_nonempty_ck',
      sql`jsonb_array_length(${t.submission_ids}) >= 1`,
    ),
  ],
);

/**
 * 已接收作答（D5 守恒/零丢失）：ResponseSet + group 证据原样冻结；
 * rejudge/appeal 只重解读原证据（D8），不改写本行。幂等键按 occurrence
 * （evaluation_group）作用域唯一：同 key 不同载荷 ⇒ 冲突而非覆盖。
 * P1-1：整行不可变 —— BEFORE UPDATE/DELETE trigger 拒绝改写/删除（0105）。
 */
export const assessment_submission = pgTable(
  'assessment_submission',
  {
    submission_id: text('submission_id').primaryKey(),
    issuance_id: text('issuance_id').notNull(),
    revision_id: text('revision_id').notNull(),
    evaluation_group_id: text('evaluation_group_id').notNull(),
    response_set: jsonb('response_set').$type<ResponseSetT>().notNull(),
    group_evidence: jsonb('group_evidence').$type<GroupEvidenceT[]>().notNull().default([]),
    idempotency_key: text('idempotency_key').notNull(),
    submitted_at: timestamp('submitted_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('assessment_submission_group_idem_uq').on(t.evaluation_group_id, t.idempotency_key),
    index('assessment_submission_issuance_idx').on(t.issuance_id),
    index('assessment_submission_revision_idx').on(t.revision_id),
    foreignKey({
      columns: [t.evaluation_group_id],
      foreignColumns: [evaluation_group.evaluation_group_id],
      name: 'assessment_submission_group_fk',
    }),
    // P1-2：(issuance, revision) 冗余坐标必须与 issuance 一致 —— 复合 FK。
    foreignKey({
      columns: [t.issuance_id, t.revision_id],
      foreignColumns: [assessment_issuance.issuance_id, assessment_issuance.revision_id],
      name: 'assessment_submission_issuance_revision_fk',
    }),
    // P1-2：作为 evaluation 复合 FK 目标 —— (submission, group) 必须一致。
    uniqueIndex('assessment_submission_id_group_uq').on(t.submission_id, t.evaluation_group_id),
  ],
);

/**
 * YUK-1052 — 服务端自动保存草稿（D11）：全部正式练习面（含 solo+placement）
 * 在 pinned issuance 上自动保存。saving/saved/error 只由服务端 ack 表达 ——
 * 本行即 ack 真相源：落库成功才回 ack，客户端 restore 只读本行。
 *
 * 与 assessment_submission 的关系：草稿是【可变】作答层（upsert 覆盖），
 * 正式提交时由 saveSubmission 冻结成不可变 submission 行并同事务清除对应
 * 草稿 —— 冻结事实（revision/issuance/group）不变，草稿永远不代表已接收
 * 作答（D5 守恒只发生在 submission 落库那一下 ack）。
 *
 * 每 issuance 一行 live draft（唯一键）；evaluation_group_ref 是草稿侧声明的
 * 联合判分组锚点（paper 联判组内多 slot 草稿共享同一 ref；null = 未定组，提交
 * 时按请求组判定，不做跨组清理）。
 */
export const assessment_response_draft = pgTable(
  'assessment_response_draft',
  {
    issuance_id: text('issuance_id').primaryKey(),
    /** 草稿声明的联合组；null = 未绑定（由提交时的 evaluation_group_id 决定）。 */
    evaluation_group_ref: text('evaluation_group_ref'),
    response_set: jsonb('response_set').$type<ResponseSetT>().notNull(),
    group_evidence: jsonb('group_evidence').$type<GroupEvidenceT[]>().notNull().default([]),
    /** 单调保存纪元：服务端 ack 序号；客户端可带 expected_save_epoch 做 stale 防线。 */
    save_epoch: integer('save_epoch').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('assessment_response_draft_group_ref_idx').on(t.evaluation_group_ref),
    foreignKey({
      columns: [t.issuance_id],
      foreignColumns: [assessment_issuance.issuance_id],
      name: 'assessment_response_draft_issuance_fk',
    }),
    check('assessment_response_draft_save_epoch_ck', sql`${t.save_epoch} >= 0`),
  ],
);

/**
 * 评估尝试（candidate 记录）：一份 submission 可有多个 attempt（重试身份 ≠
 * 学习事实身份）；candidate/shadow 永不进 latest-judge 显示通道 —— 生效与
 * 否只由 evaluation_effective_head 表达。provenance 承载 D9/D15/D16 来源
 * （automatic/manual/self_report + assisted）。
 *
 * P1（YUK-1097）：终态冻结 —— 身份坐标全列冻结；status='completed' 后
 * 整行冻结（unit_results/aggregate/plan_digest/provenance/run_refs）；
 * pending 行的载荷只随 pending→completed 迁移写一次。DELETE 一律拒绝
 * （0111 trigger）。
 */
export const evaluation = pgTable(
  'evaluation',
  {
    evaluation_id: text('evaluation_id').primaryKey(),
    evaluation_group_id: text('evaluation_group_id').notNull(),
    submission_id: text('submission_id').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status', {
      enum: ['pending', 'completed'],
    }).notNull(),
    unit_results: jsonb('unit_results').$type<ScoringUnitResultT[]>().notNull().default([]),
    aggregate: jsonb('aggregate').$type<AggregateOutcomeT>(),
    plan_digest: text('plan_digest'),
    run_refs: jsonb('run_refs').$type<string[]>().notNull().default([]),
    provenance: jsonb('provenance').$type<JsonObject>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('evaluation_submission_attempt_uq').on(t.submission_id, t.attempt),
    index('evaluation_group_idx').on(t.evaluation_group_id),
    // P1-2：evaluation 的 (submission, group) 必须与 submission 一致。
    foreignKey({
      columns: [t.submission_id, t.evaluation_group_id],
      foreignColumns: [
        assessment_submission.submission_id,
        assessment_submission.evaluation_group_id,
      ],
      name: 'evaluation_submission_group_fk',
    }),
    // P1（终验）：head 复合 FK 目标 —— (evaluation, submission, group) 三坐标
    // 全一致；取代旧 (evaluation, group) 两坐标版（唯一能力等价，不叠加冗余约束）。
    uniqueIndex('evaluation_id_submission_group_uq').on(
      t.evaluation_id,
      t.submission_id,
      t.evaluation_group_id,
    ),
    check('evaluation_status_ck', sql`${t.status} IN ('pending','completed')`),
    check('evaluation_attempt_positive_ck', sql`${t.attempt} >= 1`),
  ],
);

/**
 * 有效判定 head（§11）：与 submission/group 同事务建立；初始
 * effective_evaluation_id = NULL、generation = 0，每次有效 activation 原子 +1。
 * activation 请求必带 expected_effective_id（null-or-id）与 expected_generation
 * （请求契约见 core/schema/assessment/ids.ts —— REQUIRED，禁止省略当无条件
 * 覆盖，防 ABA）。
 *
 * CAS 注（复审）：schema 只承载 head 状态列（effective id + generation）与
 * 本表 FK 约束；【group/submission/head 同事务原子创建】、【generation 单调】
 * 与并发 activation 串行化属事务性 writer（§11 锁序），不在 DDL 层保证 ——
 * writer 落地时必须补同事务原子创建与并发竞争测试（本表注释为契约备忘）。
 */
export const evaluation_effective_head = pgTable(
  'evaluation_effective_head',
  {
    evaluation_group_id: text('evaluation_group_id').primaryKey(),
    submission_id: text('submission_id').notNull(),
    effective_evaluation_id: text('effective_evaluation_id'),
    generation: integer('generation').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('evaluation_effective_head_submission_idx').on(t.submission_id),
    // P1（终验）：head 的 (submission, group) 必须是真实同组 submission ——
    // submission_id NOT NULL ⇒ 此 FK 恒生效，NULL-effective 初始 head 也无法
    // 携带孤儿身份坐标。
    foreignKey({
      columns: [t.submission_id, t.evaluation_group_id],
      foreignColumns: [
        assessment_submission.submission_id,
        assessment_submission.evaluation_group_id,
      ],
      name: 'evaluation_effective_head_submission_fk',
    }),
    // P1（终验）：effective 非 NULL 时三坐标 (evaluation, submission, group)
    // 必须与 evaluation 行全一致 —— head 不得指向他组/他 submission 的 evaluation，
    // 也不得把 effective 挂到同组另一 submission 上。effective 为 NULL 时
    // MATCH SIMPLE 跳过（初始态合法）。
    foreignKey({
      columns: [t.effective_evaluation_id, t.submission_id, t.evaluation_group_id],
      foreignColumns: [
        evaluation.evaluation_id,
        evaluation.submission_id,
        evaluation.evaluation_group_id,
      ],
      name: 'evaluation_effective_head_evaluation_fk',
    }),
    check('evaluation_effective_head_generation_ck', sql`${t.generation} >= 0`),
  ],
);

/**
 * 历史身份映射（§3.2）：按【原始记录发生上下文】识别 ——
 * 同一 (source_kind, source_id, source_locator) 只允许一条【当前】映射
 * （部分唯一索引 WHERE is_current）；不用 (question_id, nullable part_ref)
 * 当 PK（PK 不能含 NULL，且无法区分同题不同历史版本）。
 *
 * P1-3：status 只承载【裁决结果】（pending/mapped/conflicted/
 * historical_unresolved），永不改写；当前选择由可变 is_current 表达 ——
 * 修正 = 旧行 is_current=false（status 与证据原样保留）+ 新行 is_current=true
 * 并链 supersedes_mapping_id（自 FK 保证链目标存在）。不得用覆盖 status 的
 * 方式丢失历史裁决。未能恢复的旧记录进入原生 historical_unresolved 状态，
 * 仍可查看原始证据，不得拿当前题面补造当时所见。
 *
 * P1（YUK-1097）：DB 层冻结（0111 trigger）—— 身份坐标/裁决字段/
 * created_at 一旦写入即冻结；可变列只有 is_current / supersedes_mapping_id
 * （修正链）与 pending 占位行的 evidence/algorithm_version 操作性注释刷新
 * （P1-5 契约）。DELETE 一律拒绝 —— 历史裁决不可抹除。
 */
export const assessment_identity_mapping = pgTable(
  'assessment_identity_mapping',
  {
    mapping_id: text('mapping_id').primaryKey(),
    source_kind: text('source_kind').notNull(),
    source_id: text('source_id').notNull(),
    // locator 非空且非空白（P2-B：空串不算定位）。
    source_locator: text('source_locator').notNull(),
    original_question_id: text('original_question_id').notNull(),
    legacy_part_ref: text('legacy_part_ref'),
    snapshot_digest: text('snapshot_digest'),
    target_revision_id: text('target_revision_id'),
    target_part_id: text('target_part_id'),
    target_slot_id: text('target_slot_id'),
    evidence: jsonb('evidence').$type<JsonObject>().notNull().default({}),
    algorithm_version: text('algorithm_version').notNull(),
    status: text('status', {
      enum: ['pending', 'mapped', 'conflicted', 'historical_unresolved'],
    }).notNull(),
    // 自 FK（修正链目标必须存在）：drizzle 自引用必须用惰性 AnyPgColumn
    // 回调（表级 foreignColumns 自引用会形成循环类型推导）。
    supersedes_mapping_id: text('supersedes_mapping_id').references(
      (): AnyPgColumn => assessment_identity_mapping.mapping_id,
    ),
    /** 当前选择标志（可变；同一 locator 仅一条 true，部分唯一索引强制）。 */
    is_current: boolean('is_current').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('assessment_identity_mapping_question_idx').on(t.original_question_id),
    index('assessment_identity_mapping_target_revision_idx').on(t.target_revision_id),
    foreignKey({
      columns: [t.target_revision_id],
      foreignColumns: [question_revision.revision_id],
      name: 'assessment_identity_mapping_target_revision_fk',
    }),
    // 同 locator 只允许一条当前映射 —— drizzle-kit 0.31 可 emit partial
    // index（.where，先例 question_canonical_content_hash_unique）；0104 的
    // 手写 WHERE status <> 'superseded' 版本已在 0105 DROP 并由本声明取代。
    uniqueIndex('assessment_identity_mapping_current_uq')
      .on(t.source_kind, t.source_id, t.source_locator)
      .where(sql`${t.is_current}`),
    check(
      'assessment_identity_mapping_status_ck',
      sql`${t.status} IN ('pending','mapped','conflicted','historical_unresolved')`,
    ),
    // P2-B：locator 非空白；status 依赖的目标坐标约束。
    // P2（终验）：非空白判定收紧到 btrim —— 纯空格 locator 同样拒绝。
    check('assessment_identity_mapping_locator_nonempty_ck', sql`btrim(${t.source_locator}) <> ''`),
    check(
      'assessment_identity_mapping_mapped_target_ck',
      sql`(${t.status} <> 'mapped' OR ${t.target_revision_id} IS NOT NULL)`,
    ),
    check(
      'assessment_identity_mapping_unresolved_no_target_ck',
      sql`(${t.status} <> 'historical_unresolved' OR ${t.target_revision_id} IS NULL)`,
    ),
  ],
);
