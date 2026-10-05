import {
  CUTOVER_OWNER_ACTIONS,
  CUTOVER_QUEUE_SEMANTICS,
  DLQ_DISPOSITIONS,
  DLQ_DISPOSITION_POLICY_VERSION,
  SUBSCRIPTION_OUTSTANDING_POLICY,
} from './dispositions';
import type { MigrationManifest } from './types';

// ====================================================================
// YUK-1056 — 统一切换 final backup manifest（grounding §14–§15）
// ====================================================================
//
// YUK-1048 的 migration manifest 已覆盖 §14 的观测清单（语义计数+PK /
// canonical+edge hash / projection baseline / queues+subscriptions /
// blobs+digests / unresolved 列表）。本封装把【切换前 final backup】落成一份
// 自包含工件，在 migration manifest 之外补齐运维面：
//   - pg_dump 工件身份（file/sha256/bytes/TOC）与 restore-drill 证据引用；
//   - DLQ tombstone 导出工件 + YUK-1042 处置策略（逐组，含 owner 裁决行）；
//   - YUK-1055 job epoch disposition 汇总 + 订阅 outstanding 翻译策略；
//   - owner_actions 清单（裁决/执行待办 —— manifest 自身不声称已完成）。
//
// 哈希纪律同 §14：构建输入与输出都是确定性对象；可变运维字段在
// migration_manifest.mutable_ops_fields 分离记录，本层不混入原始事实 hash。
// coverage_map 显式声明 §14 每条目在本文档中的落点（审计可逐项核对）。

export const CUTOVER_MANIFEST_VERSION = 1 as const;

/** §14 必备条目 → 本 manifest 落点（key 是审计核对清单，value 是 JSON 路径说明）。 */
export const SECTION14_COVERAGE = {
  census_semantic_counts: 'migration.semantic_counts（row 计数 + PK/digest，截断标记）',
  canonical_hash: 'migration.raw_fact_hash（canonical + per_partition）',
  edge_hash: 'migration.edge_hash',
  projection_baseline: 'migration.projection_baseline',
  queues_disposition:
    'queues.observed + queues.dlq_tombstones + queues.dlq_dispositions + queues.job_epoch_disposition',
  subscription_disposition:
    'subscriptions.policy + migration.subscriptions（checkpoints + delivery_by_status）',
  blobs_digests: 'migration.blobs（source_asset sha256/size + image_refs 合计）',
  unresolved_list: 'migration.classification.unresolved + migration.unresolved_count',
  mutable_ops_fields: 'migration.mutable_ops_fields（分离记录，不进 raw_fact_hash）',
  completeness: 'migration.completeness（snapshot_at；MAX(dispatch_seq) 非完整性声明）',
  checkpoint_identity: 'migration.checkpoint_hash + migration.source',
} as const;

export type Section14CoverageKey = keyof typeof SECTION14_COVERAGE;

export interface BackupArtifact {
  file: string;
  sha256: string;
  bytes: number;
}

export interface CutoverManifestInput {
  /** YUK-1048 migration-capture 产物（latest.json 指向的 manifest）。 */
  migration_manifest: MigrationManifest;
  /** pg_dump custom 工件（可选——final backup 执行时必须存在）。 */
  dump: (BackupArtifact & { container_image: string | null; toc_entries: number | null }) | null;
  /** DLQ/failed/pending job tombstone 导出（worker 启动自清前的档案）。 */
  dlq_export: (BackupArtifact & { rows_exported: number }) | null;
  /** 导出时点 pgboss *_dlq 队列观测计数（与 DLQ_DISPOSITIONS 对账）。 */
  dlq_observed: ReadonlyArray<{ queue: string; rows: number }> | null;
  /** YUK-1055 分类表快照（queue → drain/translate/fenced）。 */
  job_epoch_disposition: Record<string, string>;
  code_contract_epoch: string;
  assessment_contract_epoch: string;
  /** restore-drill 证据（已执行的演练；执行前可为 null）。 */
  restore_evidence:
    | (BackupArtifact & {
        verified: boolean;
        container: string;
        toc_entries: number | null;
        table_counts: Record<string, number>;
      })
    | null;
  git_sha: string | null;
  captured_at?: string;
}

/** DLQ 观测与策略表的对账结果（不符即如实报告 —— 不阻塞备份但提示 owner）。 */
export interface DlqReconciliation {
  queue: string;
  census_rows: number;
  observed_rows: number | null;
  disposition: string;
  matches: boolean | null; // null = 导出缺该队列观测（schema 缺失/未导出）
}

export function reconcileDlq(
  observed: ReadonlyArray<{ queue: string; rows: number }> | null,
): DlqReconciliation[] {
  const byQueue = new Map<string, number>();
  for (const row of observed ?? []) {
    // memory_event_ingest_dlq 等单队多组：观测聚合按队列合计。
    byQueue.set(row.queue, (byQueue.get(row.queue) ?? 0) + row.rows);
  }
  const perQueueCensus = new Map<string, number>();
  for (const d of DLQ_DISPOSITIONS) {
    perQueueCensus.set(d.queue, (perQueueCensus.get(d.queue) ?? 0) + d.census_rows);
  }
  return DLQ_DISPOSITIONS.map((d) => {
    const observedN = observed === null ? null : (byQueue.get(d.queue) ?? 0);
    return {
      queue: d.queue,
      census_rows: d.census_rows,
      observed_rows: observedN,
      disposition: d.disposition,
      // 队列级对账：观测缺该队 = 观测 0 行（truthful mismatch）；
      // 多组同队按 per-queue 合计判。
      matches:
        observed === null
          ? null
          : (perQueueCensus.get(d.queue) ?? 0) === (byQueue.get(d.queue) ?? 0),
    };
  });
}

export function buildCutoverBackupManifest(input: CutoverManifestInput) {
  const m = input.migration_manifest;
  return {
    manifest_version: CUTOVER_MANIFEST_VERSION,
    tool: { name: 'cutover-backup', version: '1.0.0' },
    captured_at: input.captured_at ?? new Date().toISOString(),
    git_sha: input.git_sha,
    contract_epochs: {
      code_contract_epoch: input.code_contract_epoch,
      assessment_contract_epoch: input.assessment_contract_epoch,
      states: ['preparing', 'ready', 'active'] as const,
    },
    /** §14 全条目落点核对表（审计逐项核对用）。 */
    section14_coverage: SECTION14_COVERAGE,
    /** §14 观测清单本体（migration-capture 输出，原样嵌入）。 */
    migration: m,
    backup: {
      dump: input.dump,
      /** pg_dump 工件不含 R2/blob 对象；blob 计数与 digest 见 migration.blobs。 */
      blob_note:
        'pg_dump 不含 R2/S3 对象字节；blob 覆盖 = source_asset digests + 行级 refs（migration.blobs），对象本体备份归 R2 侧车（docs/sub5-restore-cli.md）。',
      restore_evidence: input.restore_evidence,
      restore_drill:
        'scripts/restore-drill.sh —— 隔离 scratch pg 容器内 pg_restore + 行数核验，产出 JSON 证据（见 restore_evidence 字段；未执行时为 null，属 owner 排期动作）。',
    },
    queues: {
      semantics: CUTOVER_QUEUE_SEMANTICS,
      /** 捕获时点 pgboss.job 全量 name/state 计数（原样）。 */
      observed: m.queues.by_name_state,
      dlq_tombstones: input.dlq_export,
      dlq_dispositions: DLQ_DISPOSITIONS,
      dlq_policy_version: DLQ_DISPOSITION_POLICY_VERSION,
      dlq_reconciliation: reconcileDlq(input.dlq_observed),
      job_epoch_disposition: input.job_epoch_disposition,
      unlisted_default: 'fenced',
    },
    subscriptions: {
      policy: SUBSCRIPTION_OUTSTANDING_POLICY,
    },
    owner_actions: [...CUTOVER_OWNER_ACTIONS],
  };
}

export type CutoverBackupManifest = ReturnType<typeof buildCutoverBackupManifest>;
