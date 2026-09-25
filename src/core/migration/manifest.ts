import { canonicalHash, digestOfIds } from './canonical';
import { type CheckpointProvenance, checkpointHashOf } from './checkpoint';
import type {
  ManifestTableCount,
  MigrationCapture,
  MigrationClassification,
  MigrationManifest,
} from './types';

// ====================================================================
// YUK-1048 — migration manifest 构建器（grounding §14）—— 纯函数
// ====================================================================
//
// Manifest 覆盖 §14 清单：观测来源/版本/redacted flags、语义 row 计数+PK、
// canonical hash、edge hash、projection baseline、queues/subscription
// disposition、blobs/digests、mapping unresolved 列表。
//
// 哈希纪律（§14 硬约束）：
//   - raw_fact_hash 只覆盖 capture.rawFacts（不可变事实）；event.ingest_at、
//     *.updated_at、answer.autosaved_at 等可变运维字段只出现在
//     mutable_ops_fields —— 绝不混入事实哈希。
//   - MAX(dispatch_seq) 不是完整性证明（src/db/schema.ts:1787–1794 存在晚提交）：
//     completeness.note 显式声明，观察上界 = 快照事务时刻。

export const MAX_PK_LIST = 5_000;

/** 分类输出版本（分类语义变化时 bump —— manifest 刷新判据之一）。 */
export const CLASSIFICATION_VERSION = '1';

/** manifest 构建选项 = checkpoint provenance（P1-1：provenance 进 checkpoint 身份）。 */
export interface ManifestOptions extends CheckpointProvenance {}

/** 引用边（from → to），用于 edge hash。 */
export interface CaptureEdge {
  kind: string;
  from: string;
  to: string;
}

/**
 * 从 capture 的不可变事实构建引用边清单（确定性顺序）。
 * 边是「记录 → 记录」的引用，不是内容。
 */
export function buildCaptureEdges(capture: MigrationCapture): CaptureEdge[] {
  const facts = capture.rawFacts;
  const edges: CaptureEdge[] = [];
  const push = (kind: string, from: string, to: string) => edges.push({ kind, from, to });

  for (const e of facts.events) {
    if (e.caused_by_event_id !== null) {
      push('event.caused_by', e.id, e.caused_by_event_id);
    }
    push(`event.subject.${e.subject_kind}`, e.id, e.subject_id);
    if (e.session_id !== null) {
      push('event.session', e.id, e.session_id);
    }
  }
  for (const a of facts.answers) {
    push('answer.question', a.id, a.question_id);
    if (a.event_id !== null) push('answer.event', a.id, a.event_id);
    if (a.session_id !== null) push('answer.session', a.id, a.session_id);
    if (a.paper_artifact_id !== null) push('answer.paper_artifact', a.id, a.paper_artifact_id);
  }
  for (const l of facts.difficulty_labels) {
    push('difficulty_label.question', l.id, l.question_id);
    push('difficulty_label.attempt_event', l.id, l.attempt_event_id);
  }
  for (const c of facts.item_calibration) {
    push('item_calibration.question', c.id, c.question_id);
  }
  for (const m of facts.learning_record_mirrors) {
    if (m.attempt_event_id !== null)
      push('learning_record.attempt_event', m.id, m.attempt_event_id);
    if (m.question_id !== null) push('learning_record.question', m.id, m.question_id);
  }
  for (const q of facts.question_lineage) {
    if (q.parent_question_id !== null) push('question.parent', q.id, q.parent_question_id);
    if (q.root_question_id !== null) push('question.root', q.id, q.root_question_id);
    if (q.parent_variant_id !== null) push('question.variant_parent', q.id, q.parent_variant_id);
  }
  for (const s of facts.fsrs) {
    if (s.last_review_event_id !== null) {
      push('fsrs.last_review_event', s.id, s.last_review_event_id);
    }
  }

  edges.sort((a, b) =>
    a.kind < b.kind
      ? -1
      : a.kind > b.kind
        ? 1
        : a.from < b.from
          ? -1
          : a.from > b.from
            ? 1
            : a.to < b.to
              ? -1
              : 1,
  );
  return edges;
}

function tableCount(table: string, ids: readonly string[]): ManifestTableCount {
  return {
    table,
    rows: ids.length,
    pks: ids.length <= MAX_PK_LIST ? [...ids].sort() : null,
    pk_digest: digestOfIds(ids),
    truncated: ids.length > MAX_PK_LIST,
  };
}

export function buildMigrationManifest(
  capture: MigrationCapture,
  classification: MigrationClassification,
  options: ManifestOptions,
): MigrationManifest {
  const facts = capture.rawFacts;
  const env = capture.environment;

  const semantic_counts: ManifestTableCount[] = [
    tableCount(
      'event',
      facts.events.map((e) => e.id),
    ),
    tableCount(
      'material_fsrs_state',
      facts.fsrs.map((r) => r.id),
    ),
    tableCount(
      'mastery_state',
      facts.mastery.map((r) => r.id),
    ),
    tableCount(
      'kc_typed_state',
      facts.kc_typed.map((r) => r.id),
    ),
    tableCount(
      'learner_axis_state',
      facts.axis.map((r) => r.id),
    ),
    tableCount(
      'item_calibration',
      facts.item_calibration.map((r) => r.id),
    ),
    tableCount(
      'item_family_calibration',
      facts.family_calibration.map((r) => r.id),
    ),
    tableCount(
      'difficulty_calibration_label',
      facts.difficulty_labels.map((r) => r.id),
    ),
    tableCount(
      'selection_observation',
      facts.selection_observations.map((r) => r.id),
    ),
    tableCount(
      'answer',
      facts.answers.map((r) => r.id),
    ),
    tableCount(
      'learning_session',
      facts.sessions.map((r) => r.id),
    ),
    tableCount(
      'learning_record(mirror)',
      facts.learning_record_mirrors.map((r) => r.id),
    ),
    tableCount(
      'question(lineage)',
      facts.question_lineage.map((r) => r.id),
    ),
    tableCount(
      'source_asset',
      facts.source_assets.map((r) => r.id),
    ),
  ];

  const edges = buildCaptureEdges(capture);
  const maxDispatchSeq = facts.events.reduce<number | null>(
    (max, e) => (max === null || e.dispatch_seq > max ? e.dispatch_seq : max),
    null,
  );

  const ingestAtPresent = capture.ops.event_ingest_at.filter((r) => r.ingest_at !== null).length;

  const migrationDrift: 'unknown' | 'in_sync' | 'drift' =
    env.migrations_applied == null || options.migration_files == null
      ? 'unknown'
      : env.migrations_applied === options.migration_files
        ? 'in_sync'
        : 'drift';

  // P2-B（终轮）：classification_version 进哈希 —— 分类语义版本 bump 时，
  // 同 checkpoint 的 manifest 必须被识别为过期（refreshed）而不是同内容跳过。
  const classificationHash = canonicalHash({
    classification_version: CLASSIFICATION_VERSION,
    records: classification.records,
    unresolved: classification.unresolved,
    deferred_replay: classification.deferred_replay,
  });

  return {
    manifest_version: 1,
    tool: { name: 'migration-capture', version: options.tool_version },
    checkpoint_hash: checkpointHashOf(capture, options),
    source: {
      git_sha: options.git_sha,
      app_image: options.app_image,
      worker_image: options.worker_image,
      captured_at: new Date().toISOString(),
      isolation: env.isolation,
      db: {
        server_version: env.db_server_version,
        database_name: env.database_name,
        host_fingerprint: env.host_fingerprint,
        migrations_applied: env.migrations_applied,
        migration_files: options.migration_files,
        migration_drift: migrationDrift,
      },
      pgboss_schema_present: env.pgboss_schema_present,
    },
    redaction: options.redaction,
    semantic_counts,
    event_action_counts: [...facts.event_action_counts].sort((a, b) =>
      a.action < b.action ? -1 : a.action > b.action ? 1 : 0,
    ),
    raw_fact_hash: {
      canonical: canonicalHash(facts),
      per_partition: {
        events: canonicalHash(facts.events),
        fsrs: canonicalHash(facts.fsrs),
        mastery: canonicalHash(facts.mastery),
        kc_typed: canonicalHash(facts.kc_typed),
        axis: canonicalHash(facts.axis),
        item_calibration: canonicalHash(facts.item_calibration),
        family_calibration: canonicalHash(facts.family_calibration),
        difficulty_labels: canonicalHash(facts.difficulty_labels),
        selection_observations: canonicalHash(facts.selection_observations),
        answers: canonicalHash(facts.answers),
        sessions: canonicalHash(facts.sessions),
        learning_record_mirrors: canonicalHash(facts.learning_record_mirrors),
        question_lineage: canonicalHash(facts.question_lineage),
        source_assets: canonicalHash(facts.source_assets),
        event_action_counts: canonicalHash(facts.event_action_counts),
        projection_baseline: canonicalHash(facts.projection_baseline),
        aggregate_counts: canonicalHash(facts.aggregate_counts),
      },
    },
    edge_hash: {
      digest: canonicalHash(edges),
      edge_count: edges.length,
    },
    mutable_ops_fields: {
      excluded_from_fact_hash: [
        'event.ingest_at',
        'material_fsrs_state.updated_at',
        'mastery_state.updated_at',
        'kc_typed_state.updated_at',
        'learner_axis_state.updated_at',
        'item_calibration.updated_at',
        'item_family_calibration.updated_at',
        'answer.autosaved_at',
        'learning_session.version',
        'learning_session.updated_at',
      ],
      event_ingest_at_present: ingestAtPresent,
      state_updated_at_max: capture.ops.state_updated_at_max,
    },
    projection_baseline: facts.projection_baseline,
    queues: {
      pgboss_schema_present: env.pgboss_schema_present,
      by_name_state: [...capture.queues].sort((a, b) =>
        a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : a.state < b.state
              ? -1
              : a.state > b.state
                ? 1
                : 0,
      ),
      dlq_total: capture.queues
        .filter((q) => q.state === 'failed' || q.state === 'dead_letter')
        .reduce((sum, q) => sum + q.count, 0),
    },
    subscriptions: {
      checkpoints: [...capture.subscription_checkpoints].sort((a, b) =>
        a.subscriber_id < b.subscriber_id
          ? -1
          : a.subscriber_id > b.subscriber_id
            ? 1
            : a.subscriber_version - b.subscriber_version,
      ),
      delivery_by_status: [...capture.subscription_deliveries].sort((a, b) =>
        a.subscriber_id < b.subscriber_id
          ? -1
          : a.subscriber_id > b.subscriber_id
            ? 1
            : a.status < b.status
              ? -1
              : a.status > b.status
                ? 1
                : 0,
      ),
    },
    blobs: {
      source_assets: facts.source_assets.map((a) => ({
        id: a.id,
        sha256: a.sha256,
        byte_size: a.byte_size,
        mime_type: a.mime_type,
      })),
      source_documents: facts.aggregate_counts.source_documents,
      question_image_refs_total: facts.aggregate_counts.question_image_refs_total,
      answer_image_refs_total: facts.answers.reduce((sum, a) => sum + a.image_refs.length, 0),
    },
    classification: {
      classification_version: CLASSIFICATION_VERSION,
      classification_hash: classificationHash,
      records: classification.records,
      unresolved: classification.unresolved,
      deferred_replay: classification.deferred_replay,
    },
    classification_rollup: classification.rollup,
    unresolved_count: classification.unresolved.length,
    deferred_replay_count: classification.deferred_replay.length,
    completeness: {
      max_dispatch_seq: maxDispatchSeq,
      captured_event_rows: facts.events.length,
      note: 'MAX(dispatch_seq) 不是完整性证明 —— event 存在晚提交（src/db/schema.ts:1787–1794 dispatch_seq 与提交序无因果约束）；本清单的观察上界是 REPEATABLE READ 快照时刻（snapshot_at），快照后的晚提交不在本捕获内。',
      snapshot_at: env.snapshot_at,
    },
  };
}
