import type { HistoricalUnknownSubmissionT, PendingStateT } from '../schema/assessment';

// ====================================================================
// YUK-1048 — 迁移捕获 · 数据契约（grounding §13–§14）
// ====================================================================
//
// 本文件是【纯数据类型】：capture 是对 cutover checkpoint 的精确观测
// （不是重算、不是 replay 证明）；manifest 是 §14 清单；classification 是
// native 分类输出。不 import 任何 DB/drizzle —— server 侧 capture reader
// （src/server/migration/capture.ts）负责把 DB 行变成这些形状。
//
// 可变运维字段纪律（§14）：event.ingest_at、*.updated_at、answer.autosaved_at、
// learning_session.version 等可变字段只进 `ops`，绝不进 rawFacts（哈希只覆盖
// rawFacts）。类型本身即文档：RawXxx 只声明事实列，OpsXxx 只声明运维列。
//
// 平行 lane 接缝：YUK-1044 拥有 question_revision/admission/issuance/submission/
// evaluation/mapping 等新表 —— 本 lane 不引用那些表。分类结果以
// MigrationTargetRef（结构化描述符）表达「应落入的 native 语义位」，由后续
// importer lane 消费；不在此处写任何目标表。

// ───────────────────────── raw rows（事实列） ─────────────────────────

/** event 表 — 不可变事实列（ingest_at 除外，见 EventOpsRow）。 */
export interface RawEventRow {
  id: string;
  dispatch_seq: number;
  session_id: string | null;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  payload: unknown;
  caused_by_event_id: string | null;
  affected_scopes: string[];
  task_run_id: string | null;
  cost_micro_usd: number | null;
  created_at: string;
}

/** event 表 — 可变运维列（另行记录，绝不进 raw-fact 哈希）。 */
export interface EventOpsRow {
  event_id: string;
  ingest_at: string | null;
}

export interface RawFsrsRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  state: unknown;
  due_at: string;
  last_review_event_id: string | null;
}

export interface RawMasteryRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: string | null;
  theta_precision: number;
  last_theta_delta: number | null;
  theta_grid_json: unknown;
  rt_correct_ms: unknown;
  calibration_residual: number | null;
  fluency_illusion_flag: boolean | null;
}

export interface RawKcTypedRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  typed_state: string;
  confused_with_kc_id: string | null;
  lifecycle: string;
  evidence_event_ids: string[];
  last_evidence_at: string | null;
}

export interface RawAxisRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  drift_v: number | null;
  boundary_a: number | null;
  ter: number | null;
  n_obs: number;
  provenance: string;
}

export interface RawItemCalibrationRow {
  id: string;
  question_id: string;
  b: number | null;
  confidence: number | null;
  track: string;
  source: string;
  b_anchor: number | null;
  b_calib: number | null;
  calibration_n: number;
  calibration_weight: number | null;
}

export interface RawFamilyCalibrationRow {
  id: string;
  family_key: string;
  b_delta: number;
  evidence_count: number;
  calibrated_n: number;
  confidence: number;
}

export interface RawDifficultyLabelRow {
  id: string;
  question_id: string;
  attempt_event_id: string;
  theta_snapshot: number;
  outcome: number;
  b_label: number;
  inclusion_probability: number;
  created_at: string;
}

export interface RawSelectionObservationRow {
  id: string;
  date: string;
  stream_item_id: string | null;
  ref_kind: string;
  ref_id: string;
  policy: string;
  selected: boolean;
  inclusion_probability: number;
  signals: unknown;
  created_at: string;
}

/** answer 表 — 事实列（autosaved_at 可变运维 → ops）。 */
export interface RawAnswerRow {
  id: string;
  question_id: string;
  learning_item_id: string | null;
  input_kind: string;
  /** 脱敏模式下为占位（redact.ts）；默认为原文。 */
  content_md: string | RedactedTextPlaceholder;
  image_refs: string[];
  vision_extracted: string | RedactedTextPlaceholder | null;
  tags: string[];
  submitted_at: string | null;
  session_id: string | null;
  paper_artifact_id: string | null;
  part_ref: string | null;
  event_id: string | null;
}

/** 脱敏文本占位（结构保留、内容哈希化）。 */
export interface RedactedTextPlaceholder {
  __redacted: true;
  sha256: string;
  length: number;
}

export interface RawSessionRow {
  id: string;
  type: string;
  status: string;
  source_document_id: string | null;
  artifact_id: string | null;
  started_at: string;
  ended_at: string | null;
}

/** learning_record 里与作答断言相关的镜像（manual mistake / import）。 */
export interface RawLearningRecordMirrorRow {
  id: string;
  kind: string;
  source: string;
  attempt_event_id: string | null;
  question_id: string | null;
}

/** question 结构血缘（不捕获题面内容 —— 内容属 census 范畴，此处只要坐标）。 */
export interface RawQuestionLineageRow {
  id: string;
  kind: string;
  source: string;
  draft_status: string | null;
  parent_question_id: string | null;
  part_index: number | null;
  root_question_id: string | null;
  parent_variant_id: string | null;
  knowledge_ids: string[];
  image_refs: string[];
  created_at: string;
}

export interface RawSourceAssetRow {
  id: string;
  kind: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
}

// ───────────────────────── 观测环境/探针 ─────────────────────────

export interface CaptureEnvironment {
  /** 快照事务的 now()（PG 语义 = 事务快照时刻）。 */
  snapshot_at: string;
  db_server_version: string;
  database_name: string;
  /** host 指纹（sha256 前 12 位）——不落明文 host，防止清单外泄拓扑。 */
  host_fingerprint: string;
  migrations_applied: number | null;
  pgboss_schema_present: boolean;
  isolation: 'repeatable read read only';
}

export interface QueueDisposition {
  name: string;
  state: string;
  count: number;
}

export interface SubscriptionCheckpointDisposition {
  subscriber_id: string;
  subscriber_version: number;
  status: string;
  next_delivery_seq: number;
}

export interface SubscriptionDeliveryDisposition {
  subscriber_id: string;
  status: string;
  count: number;
}

export interface AiTaskRunCounts {
  task_kind: string;
  status: string;
  count: number;
}

// ───────────────────────── capture 顶层形状 ─────────────────────────

/** 不可变事实分区（canonical hash 只覆盖这里）。 */
export interface MigrationRawFacts {
  events: RawEventRow[];
  fsrs: RawFsrsRow[];
  mastery: RawMasteryRow[];
  kc_typed: RawKcTypedRow[];
  axis: RawAxisRow[];
  item_calibration: RawItemCalibrationRow[];
  family_calibration: RawFamilyCalibrationRow[];
  difficulty_labels: RawDifficultyLabelRow[];
  selection_observations: RawSelectionObservationRow[];
  answers: RawAnswerRow[];
  sessions: RawSessionRow[];
  learning_record_mirrors: RawLearningRecordMirrorRow[];
  question_lineage: RawQuestionLineageRow[];
  source_assets: RawSourceAssetRow[];
  /** event 全表按 action 计数（包含未捕获 body 的 action —— 只计数）。 */
  event_action_counts: Array<{ action: string; count: number }>;
  /** 8 类 canonical fold owner 的投影基线（§10 entity-registry）。 */
  projection_baseline: Record<string, number>;
  aggregate_counts: {
    source_documents: number;
    question_image_refs_total: number;
  };
}

/** 可变运维字段（另行记录；只做对账，绝不进 raw-fact hash）。 */
export interface MigrationOpsFields {
  event_ingest_at: EventOpsRow[];
  /** 快照时刻各状态表 updated_at 的 max 值（对账用）。 */
  state_updated_at_max: Record<string, string | null>;
}

export interface MigrationCapture {
  capture_schema_version: 1;
  environment: CaptureEnvironment;
  rawFacts: MigrationRawFacts;
  ops: MigrationOpsFields;
  queues: QueueDisposition[];
  subscription_checkpoints: SubscriptionCheckpointDisposition[];
  subscription_deliveries: SubscriptionDeliveryDisposition[];
  ai_task_runs: AiTaskRunCounts[];
}

// ───────────────────────── native 分类（§13） ─────────────────────────

/**
 * native 语义位。完整 attempt → submission+imported eval/head；embedded tutor
 * grade；attribution-only；human/import assertion（诚实标注）；pending 缺件 →
 * blocked；缺 issued snapshot → historical_unresolved（绝不用当前 revision 补造）；
 * correction cycles 保持 unresolved；live draft 精确保留；review/snapshot 世系
 * 只做 lineage。
 */
export type NativeCategory =
  | 'complete_attempt'
  | 'embedded_tutor_grade'
  | 'attribution_only'
  | 'attribution_pending_placeholder'
  | 'human_import_assertion'
  | 'pending_blocked'
  | 'pending_resolved_lineage'
  | 'live_draft'
  | 'historical_unresolved'
  | 'correction_cycle_unresolved'
  | 'fsrs_review_lineage'
  | 'state_snapshot_lineage'
  /** 因 evidence/causal 闭包被捕获的非评估事件（P1-7）—— 只作引用世系。 */
  | 'causal_closure_lineage';

/**
 * 迁移目标接缝（平行 lane YUK-1044 拥有目标表；本 lane 只产出语义描述符）。
 * importer lane 据此把分类记录写入 submission/evaluation/mapping —— 本模块
 * 不引用、不写任何目标表。
 */
export type MigrationTargetRef =
  | {
      kind: 'submission_with_imported_eval';
      /**
       * 判分证据：独立 judge 事件 id（null = 评估嵌入在 submission 事件本身的
       * judge 块内，如 review-settlement 的 embedded judge / durable 回填）。
       */
      judge_event_id: string | null;
      /**
       * 一次 occurrence 至多一个 effective head（P1-4）：多 verdict 按 legacy
       * newest-judge-wins（practice-read.ts 读语义）选头；并列/被纠正 → 不选。
       */
      has_effective_head: boolean;
      /** 选头依据（审计可读）。ambiguous_held 时 anchor 侧为 pending。 */
      head_selection: 'sole_verdict' | 'legacy_newest_judge' | 'not_selected' | 'ambiguous_held';
    }
  | {
      kind: 'submission_with_embedded_eval';
      /** 判分嵌在 attempt payload（solve_tutor）；provenance 诚实标注。 */
      provenance: 'embedded_tutor';
    }
  | { kind: 'attribution_evidence_only' }
  | { kind: 'manual_provenance_only'; assertion: 'human' | 'import' }
  | { kind: 'pending_carried'; pending: PendingStateT }
  | { kind: 'draft_preserved' }
  | { kind: 'historical_unknown'; record: HistoricalUnknownSubmissionT }
  | { kind: 'unresolved_correction_cycle' }
  | { kind: 'lineage_only' };

export interface RecordClassification {
  category: NativeCategory;
  source_kind: 'event' | 'answer';
  source_id: string;
  /** 原始记录定位符（与 §3.2 mapping locator 同构：source_kind:action:id）。 */
  source_locator: string;
  reason: string;
  evidence_event_ids: string[];
  native_target: MigrationTargetRef;
}

/** deferred replay 工作清单条目（correction cycles / reproject_deferred 标记）。 */
export interface DeferredReplayEntry {
  source_kind: 'correction_cycle' | 'reproject_deferred_marker';
  source_id: string;
  affected_subject_ids: string[];
  reason: string;
}

export interface MigrationClassification {
  records: RecordClassification[];
  /** 每 category 计数（含 0 值条目省略）。 */
  rollup: Record<string, number>;
  deferred_replay: DeferredReplayEntry[];
  /** §3.2/§14 mapping unresolved 列表（历史缺冻结上下文 + correction cycles）。 */
  unresolved: Array<{
    source_kind: string;
    source_id: string;
    source_locator: string;
    reason: string;
  }>;
}

// ───────────────────────── manifest（§14） ─────────────────────────

export interface ManifestTableCount {
  table: string;
  rows: number;
  /** 主键清单（≤ MAX_PK_LIST 时列出；超出仅 digest）。 */
  pks: string[] | null;
  pk_digest: string;
  truncated: boolean;
}

export interface MigrationManifest {
  manifest_version: 1;
  tool: { name: 'migration-capture'; version: string };
  /**
   * 整个观测 checkpoint 的内容身份（P1-1）：覆盖 rawFacts + ops + queues +
   * subscriptions + ai_task_runs + environment（不含随运行变化的
   * snapshot_at/captured_at）+ provenance。工件文件名按它寻址 —— 运维态
   * （队列/订阅/ingest_at）变化会产生新 checkpoint，不会被旧工件吞掉。
   */
  checkpoint_hash: string;
  /** 观测来源/版本/redacted flags。 */
  source: {
    git_sha: string | null;
    app_image: string | null;
    worker_image: string | null;
    captured_at: string;
    isolation: 'repeatable read read only';
    db: {
      server_version: string;
      database_name: string;
      host_fingerprint: string;
      migrations_applied: number | null;
      migration_files: number | null;
      migration_drift: 'unknown' | 'in_sync' | 'drift';
    };
    pgboss_schema_present: boolean;
  };
  redaction: { applied: boolean; fields: string[] };
  /** 语义 row 计数 + PK。 */
  semantic_counts: ManifestTableCount[];
  /** event 按 action 的计数（含未捕获 body 的 action —— 只计数）。 */
  event_action_counts: Array<{ action: string; count: number }>;
  /** canonical hash：仅不可变事实（可变运维字段绝不混入）。 */
  raw_fact_hash: {
    canonical: string;
    per_partition: Record<string, string>;
  };
  /** 引用边哈希（caused_by / subject / answer→event / label→attempt 等）。 */
  edge_hash: { digest: string; edge_count: number };
  /** 可变运维字段的独立对账记录（不进 raw_fact_hash）。 */
  mutable_ops_fields: {
    excluded_from_fact_hash: string[];
    event_ingest_at_present: number;
    state_updated_at_max: Record<string, string | null>;
  };
  /** 8 类 canonical fold owner 的投影基线（§10 entity-registry）。 */
  projection_baseline: Record<string, number>;
  queues: { pgboss_schema_present: boolean; by_name_state: QueueDisposition[]; dlq_total: number };
  subscriptions: {
    checkpoints: SubscriptionCheckpointDisposition[];
    delivery_by_status: SubscriptionDeliveryDisposition[];
  };
  blobs: {
    source_assets: Array<{ id: string; sha256: string; byte_size: number; mime_type: string }>;
    source_documents: number;
    question_image_refs_total: number;
    answer_image_refs_total: number;
  };
  /** 完整分类输出随清单持久化（P1-2）：records + unresolved + deferred_replay。 */
  classification: {
    classification_version: string;
    /** canonical hash of {records, unresolved, deferred_replay} —— 刷新判据。 */
    classification_hash: string;
    records: RecordClassification[];
    unresolved: MigrationClassification['unresolved'];
    deferred_replay: DeferredReplayEntry[];
  };
  classification_rollup: Record<string, number>;
  unresolved_count: number;
  deferred_replay_count: number;
  completeness: {
    max_dispatch_seq: number | null;
    captured_event_rows: number;
    /** 显式声明：MAX(dispatch_seq) 不是完整性证明（schema.ts:1787–1794 晚提交存在）。 */
    note: string;
    snapshot_at: string;
  };
}
