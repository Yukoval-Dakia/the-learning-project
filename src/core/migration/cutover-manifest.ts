import { z } from 'zod';
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

export const CUTOVER_MANIFEST_VERSION = 2 as const;

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
  restore_evidence: (BackupArtifact & RestoreReceipt) | null;
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
    tool: { name: 'cutover-backup', version: '2.0.0' },
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
        'scripts/restore-drill.sh —— 隔离 scratch pg 容器内恢复同一 staged dump，比较完整非 system schema/table 内容与序列；当前证明须通过独立 --require-restore-parity。旧 verified 为历史报告。',
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

// Logical bytes, not exhaustive DDL/roles/blob/Mem0 or worker-reopen acceptance.
export const CONTENT_ALGORITHM = 'pg16-column-text-sha256-multiset-v1';
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedDecimal = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1);
export const relationIdentitySchema = z.strictObject({ schema: identifier, name: identifier });
export const artifactIdentitySchema = z.strictObject({
  file: z.string(),
  sha256: sha,
  bytes: decimal,
});
export const databaseIdentitySchema = z.strictObject({
  cluster: decimal,
  database_oid: decimal,
  database: identifier,
  server_version: z.string().regex(/^16\./),
  server_started_at: z.iso.datetime({ offset: true }),
  in_recovery: z.boolean(),
  server_address: z.string().nullable(),
  server_port: z.number().int().nullable(),
});
export const columnDescriptorSchema = z.strictObject({
  name: identifier,
  type: relationIdentitySchema,
  type_chain: z
    .array(
      relationIdentitySchema.extend({
        kind: z.enum(['builtin', 'vector', 'enum', 'domain', 'array']),
        enum_labels: z.array(z.string()),
        domain_not_null: z.boolean(),
        modifier: z.number().int(),
      }),
    )
    .min(1),
  modifier: z.number().int(),
  dimensions: z.number().int().nonnegative(),
  collation: relationIdentitySchema.nullable(),
});
export const tableMetadataSchema = relationIdentitySchema.extend({
  kind: z.enum(['r', 'p', 'm', 'f']),
  persistence: z.enum(['p', 'u', 't']),
  partition: z.boolean(),
  partition_bound: z.string().nullable(),
  parents: z.array(relationIdentitySchema),
  columns: z.array(columnDescriptorSchema),
});
export const tableManifestSchema = tableMetadataSchema.extend({ rows: decimal, sha256: sha });
export const sequenceManifestSchema = relationIdentitySchema.extend({
  type: relationIdentitySchema,
  start: signedDecimal,
  increment: signedDecimal,
  min: signedDecimal,
  max: signedDecimal,
  cache: decimal,
  cycle: z.boolean(),
  owner: relationIdentitySchema.extend({ column: identifier }).nullable(),
  last_value: signedDecimal,
  is_called: z.boolean(),
});
export const databaseManifestSchema = z.strictObject({
  algorithm: z.literal(CONTENT_ALGORITHM),
  encoding: z.literal('UTF8'),
  server_version: z.string().regex(/^16\./),
  extensions: z.array(z.strictObject({ name: identifier, version: identifier })),
  schemas: z.array(identifier),
  tables: z.array(tableManifestSchema),
  sequences: z.array(sequenceManifestSchema),
});
const maintenanceFields = {
  format: z.literal('loom-maintenance-boundary'),
  basis: z.literal('external-maintenance-boundary'),
  owner: identifier,
  window: identifier,
  established_at: z.iso.datetime({ offset: true }),
  held_until_explicit_release: z.literal(true),
  source: databaseIdentitySchema,
  source_revision: z.string().regex(/^[a-f0-9]{40}$/),
  restart_admission_control: z.literal('enforced'),
  other_clients_control: z.literal('enforced'),
  background_writers_control: z.literal('enforced'),
  writers: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('container'),
          id: identifier,
          state: z.literal('stopped'),
        }),
        z.strictObject({
          kind: z.literal('external'),
          name: identifier,
          control: z.literal('enforced'),
        }),
      ]),
    )
    .min(1),
};
export const quiescenceEvidenceSchema = z.discriminatedUnion('version', [
  z.strictObject({
    ...maintenanceFields,
    version: z.literal(1),
    app_image: z.string().regex(/^(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}$/),
    worker_image: z.string().regex(/^(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}$/),
  }),
  z
    .strictObject({
      ...maintenanceFields,
      version: z.literal(2),
      execution: z.strictObject({
        kind: z.literal('host-node-v1'),
        app: z.strictObject({ kind: z.literal('absent') }),
        runtime: z.strictObject({
          kind: z.literal('node'),
          version: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/),
          artifact: artifactIdentitySchema.extend({ file: identifier }),
        }),
        worker: z.strictObject({
          name: identifier,
          artifact: artifactIdentitySchema.extend({ file: identifier }),
        }),
      }),
    })
    .refine(
      (evidence) =>
        evidence.writers.some(
          (writer) => writer.kind === 'external' && writer.name === evidence.execution.worker.name,
        ),
      'host worker must have an enforced external writer control',
    ),
]);
export const quiescenceBindingSchema = z.strictObject({
  artifact: artifactIdentitySchema,
  evidence: quiescenceEvidenceSchema,
  assurance: z.literal('operator-attested-with-observations'),
  observations: z
    .array(
      z.strictObject({
        at: z.iso.datetime({ offset: true }),
        sessions: z.literal('no-unowned-clients'),
        prepared_transactions: z.literal('none'),
        containers: z.literal('stopped'),
      }),
    )
    .min(2),
});
export const sourceManifestSchema = z.strictObject({
  format: z.literal('loom-db-source'),
  version: z.literal(2),
  helper_revision: z.string().regex(/^[a-f0-9]{40}$/),
  source: databaseIdentitySchema,
  source_image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  client_versions: z.strictObject({
    psql: identifier,
    pg_dump: identifier,
    pg_restore: identifier,
  }),
  snapshot: z.string().regex(/^[a-fA-F0-9]+-[a-fA-F0-9]+-[0-9]+$/),
  started_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }),
  quiescence: quiescenceBindingSchema,
  dump: artifactIdentitySchema,
  toc_entries: z.number().int().nonnegative(),
  companions: z.strictObject({
    basis: z.literal('external-maintenance-boundary'),
    dlq: artifactIdentitySchema,
    migration: artifactIdentitySchema,
  }),
  inventory: databaseManifestSchema,
});
export const comparisonSchema = z.strictObject({
  kind: z.enum(['equal', 'different']),
  missing_schemas: z.array(identifier),
  extra_schemas: z.array(identifier),
  missing_tables: z.array(relationIdentitySchema),
  extra_tables: z.array(relationIdentitySchema),
  mismatched_tables: z.array(relationIdentitySchema),
  missing_sequences: z.array(relationIdentitySchema),
  extra_sequences: z.array(relationIdentitySchema),
  mismatched_sequences: z.array(relationIdentitySchema),
  environment_mismatches: z.array(z.string()),
});
export const restorePhaseSchema = z.enum([
  'preflight',
  'staging',
  'bindings',
  'start',
  'toc',
  'restore',
  'inspection',
  'comparison',
  'cleanup',
]);
export const phaseOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), phase: restorePhaseSchema }),
  z.strictObject({ kind: z.literal('failed'), phase: restorePhaseSchema }),
]);
export const restoreErrorSchema = z.strictObject({
  phase: z.string(),
  code: identifier,
  message: z.string(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  stderrTail: z.string().max(4096).optional(),
  truncated: z.boolean().optional(),
});
const receiptFields = {
  format: z.literal('loom-restore-drill'),
  version: z.literal(2),
  started_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }),
  dump: artifactIdentitySchema.nullable(),
  source_manifest: artifactIdentitySchema.nullable(),
  source: sourceManifestSchema.nullable(),
  restored: databaseManifestSchema.nullable(),
  quiescence: quiescenceBindingSchema.nullable(),
  scratch: z.strictObject({
    image: z.string(),
    container: z.string(),
    retained: z.boolean(),
    ownership: z
      .strictObject({
        container_id: z.string().regex(/^[a-f0-9]{64}$/),
        attempt: z.uuid(),
        volumes: z.array(z.strictObject({ name: identifier, destination: identifier })),
      })
      .optional(),
    reopen: z
      .strictObject({
        kind: z.literal('retained-loopback-v1'),
        container_id: z.string().regex(/^[a-f0-9]{64}$/),
        host: z.literal('127.0.0.1'),
        port: z.number().int().min(1024).max(65535),
        identity: databaseIdentitySchema.extend({
          database: z.string().regex(/^test_fork_[0-9]+$/),
          in_recovery: z.literal(false),
        }),
      })
      .optional(),
  }),
  phases: z.array(phaseOutcomeSchema),
  comparison: comparisonSchema.nullable(),
  errors: z.array(restoreErrorSchema),
};
export const currentRestoreReceiptSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...receiptFields,
      kind: z.literal('verified'),
      verified: z.literal(true),
      level: z.literal('database-content-parity'),
    }),
    z.strictObject({
      ...receiptFields,
      kind: z.literal('failed'),
      verified: z.literal(false),
      level: z.literal('failed'),
    }),
    z.strictObject({
      ...receiptFields,
      kind: z.literal('sql-restore-only'),
      verified: z.literal(false),
      level: z.literal('sql-restore-only'),
    }),
  ])
  .refine(
    (receipt) =>
      !receipt.scratch.reopen ||
      (receipt.kind === 'verified' &&
        receipt.scratch.retained &&
        receipt.scratch.ownership?.container_id === receipt.scratch.reopen.container_id),
    'reopen requires a verified retained owned container',
  );
export type DatabaseIdentity = z.infer<typeof databaseIdentitySchema>;
export type ArtifactIdentity = z.infer<typeof artifactIdentitySchema>;
export type DatabaseManifest = z.infer<typeof databaseManifestSchema>;
export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type QuiescenceEvidence = z.infer<typeof quiescenceEvidenceSchema>;
export type TableMetadata = z.infer<typeof tableMetadataSchema>;
export type DatabaseComparison = z.infer<typeof comparisonSchema>;
export type CurrentRestoreReceipt = z.infer<typeof currentRestoreReceiptSchema>;
export type RestoreError = z.infer<typeof restoreErrorSchema>;
export type RestorePhase = z.infer<typeof restorePhaseSchema>;
export type PhaseOutcome = z.infer<typeof phaseOutcomeSchema>;
export type RestoreReceipt =
  | CurrentRestoreReceipt
  | {
      kind: 'legacy-limited';
      level: 'legacy-limited';
      verified: false;
      reported_verified: boolean | null;
      container: string;
      toc_entries: number | null;
      table_counts: Record<string, number>;
      dump: { sha256?: string };
      historical: unknown;
    };
