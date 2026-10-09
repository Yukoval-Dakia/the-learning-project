// YUK-1056 — 统一切换 final backup manifest CLI（grounding §14–§15）。
//
// 把「切换前最终备份」的工件封进一份自包含 manifest：
//   pnpm tsx scripts/cutover-backup.ts --capture-dir=<dir> --out=<dir> \
//       --dump=<loom-YYYYMMDD.dump> --toc-entries=<n> \
//       --dlq=<dlq-tombstones.json> [--restore-evidence=<drill.json>] \
//       [--git-sha=<sha>] [--strict]
//
// 输入契约（由 cutover-final-backup.sh 生成，手工组装亦可）：
//   --capture-dir  含 latest.json 的 migration-capture 输出目录（YUK-1048）；
//                  或 --manifest=<file> 直接指 manifest-*.json。
//   --dump         pg_dump -Fc 工件（sha256/bytes 本脚本计算）。
//   --toc-entries  容器内 `pg_restore -l` 的 TOC 条目数（dump 完整性观测）。
//   --dlq          maintenance interval 内的 pgboss.job 导出（JSON 数组；行含
//                  name/state 字段即够用——本脚本按 *_dlq 聚合对账）。
//   --restore-evidence  restore-drill.sh 产出的 JSON 证据（可后补）。
//
// --strict：必备工件缺失（migration manifest / dump / dlq export）时 exit 1。
// 默认报告式：全部缺口进 warnings[] 落盘，exit 0 —— 试运行/演练可部分执行，
// 统一切换 runbook 的正式执行必须 --strict。

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { stableStringify } from '@/core/migration/canonical';
import {
  type ArtifactIdentity,
  CONTENT_ALGORITHM,
  type CurrentRestoreReceipt,
  type CutoverBackupManifest,
  type DatabaseComparison,
  type DatabaseIdentity,
  type DatabaseManifest,
  type QuiescenceEvidence,
  type RestoreError,
  type RestorePhase,
  type RestoreReceipt,
  type SourceManifest,
  type TableMetadata,
  buildCutoverBackupManifest,
  currentRestoreReceiptSchema,
  databaseIdentitySchema,
  databaseManifestSchema,
  quiescenceEvidenceSchema,
  sequenceManifestSchema,
  sourceManifestSchema,
  tableMetadataSchema,
} from '@/core/migration/cutover-manifest';
import type { MigrationManifest } from '@/core/migration/types';
import { HistoricalUnknownSubmission } from '@/core/schema/assessment/judgment';
import { PendingState } from '@/core/schema/assessment/pending';
import { JOB_EPOCH_DISPOSITION } from '@/server/contract-epoch/jobs';
import { ASSESSMENT_CONTRACT_EPOCH, CODE_CONTRACT_EPOCH } from '@/server/contract-epoch/rules';

export interface CutoverBackupArgs {
  captureDir: string | null;
  manifest: string | null;
  out: string | null;
  dump: string | null;
  tocEntries: string | null;
  dlq: string | null;
  restoreEvidence: string | null;
  gitSha: string | null;
  strict: boolean;
  sourceManifest: string | null;
  quiescenceEvidence: string | null;
  requireRestoreParity: boolean;
}

export function parseCutoverBackupArgs(argv: string[]): CutoverBackupArgs {
  const readFlag = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(`--${flag}=`.length);
    const idx = argv.indexOf(`--${flag}`);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
    return null;
  };
  return {
    captureDir: readFlag('capture-dir'),
    manifest: readFlag('manifest'),
    out: readFlag('out'),
    dump: readFlag('dump'),
    tocEntries: readFlag('toc-entries'),
    dlq: readFlag('dlq'),
    restoreEvidence: readFlag('restore-evidence'),
    gitSha: readFlag('git-sha'),
    strict: argv.includes('--strict'),
    sourceManifest: readFlag('source-manifest'),
    quiescenceEvidence: readFlag('quiescence-evidence'),
    requireRestoreParity: argv.includes('--require-restore-parity'),
  };
}

export function sha256File(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const h = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      h.update(buffer.subarray(0, n));
    }
    return h.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function currentGitSha(): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** latest.json → manifest 文件名；--manifest 直给优先。 */
export function resolveManifestPath(captureDir: string, manifestArg: string | null): string {
  if (manifestArg !== null) {
    return isAbsolute(manifestArg) ? manifestArg : resolve(manifestArg);
  }
  const latestPath = join(captureDir, 'latest.json');
  const latest = z
    .object({ manifest_file: z.string() })
    .parse(JSON.parse(readFileSync(latestPath, 'utf8')));
  if (typeof latest.manifest_file !== 'string') {
    throw new Error(`${latestPath} 缺 manifest_file 字段`);
  }
  return join(captureDir, latest.manifest_file);
}

interface DlqExportRow {
  name?: string;
  state?: string;
  [k: string]: unknown;
}

/** 从 DLQ 导出 JSON（行数组或 {rows:[]}）按 *_dlq 队列聚合观测计数。 */
export function observedDlqCounts(rows: DlqExportRow[]): {
  queue: string;
  rows: number;
}[] {
  const byQueue = new Map<string, number>();
  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name.endsWith('_dlq')) continue;
    byQueue.set(name, (byQueue.get(name) ?? 0) + 1);
  }
  return [...byQueue.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([queue, n]) => ({ queue, rows: n }));
}

export function readDlqExport(path: string): { rows: DlqExportRow[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const row = z.object({ name: z.string().optional(), state: z.string().optional() }).passthrough();
  const rows = z.union([z.array(row), z.object({ rows: z.array(row) })]).parse(parsed);
  return { rows: Array.isArray(rows) ? rows : rows.rows };
}

export function buildManifest(args: CutoverBackupArgs): {
  manifest: CutoverBackupManifest;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (args.captureDir === null && args.manifest === null) {
    throw new Error('需要 --capture-dir=<dir> 或 --manifest=<file>');
  }
  const captureDir = args.captureDir
    ? isAbsolute(args.captureDir)
      ? args.captureDir
      : resolve(args.captureDir)
    : process.cwd();
  const manifestPath = resolveManifestPath(captureDir, args.manifest);
  const migration = migrationManifestBoundary.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (typeof migration.checkpoint_hash !== 'string') {
    throw new Error(`${manifestPath} 不是 migration manifest（缺 checkpoint_hash）`);
  }

  let dump = null;
  if (args.dump !== null) {
    if (!existsSync(args.dump)) throw new Error(`dump 不存在: ${args.dump}`);
    dump = {
      file: resolve(args.dump),
      sha256: sha256File(args.dump),
      bytes: statSync(args.dump).size,
      container_image: null,
      toc_entries:
        args.tocEntries === null
          ? null
          : z
              .string()
              .regex(/^(0|[1-9][0-9]*)$/)
              .transform(Number)
              .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
              .parse(args.tocEntries),
    };
  } else {
    warnings.push('missing_dump: 无 --dump —— final backup 正式执行必须带 pg_dump 工件');
  }

  let dlqExport = null;
  let dlqObserved: Array<{ queue: string; rows: number }> | null = null;
  if (args.dlq !== null) {
    if (!existsSync(args.dlq)) throw new Error(`dlq export 不存在: ${args.dlq}`);
    const { rows } = readDlqExport(args.dlq);
    dlqObserved = observedDlqCounts(rows);
    dlqExport = {
      file: resolve(args.dlq),
      sha256: sha256File(args.dlq),
      bytes: statSync(args.dlq).size,
      rows_exported: rows.length,
    };
  } else {
    warnings.push('missing_dlq_export: 无 --dlq —— 必须保留 DLQ tombstone');
  }

  let restoreEvidence:
    | (import('@/core/migration/cutover-manifest').BackupArtifact & RestoreReceipt)
    | null = null;
  const sourceArtifact =
    args.sourceManifest === null ? null : readJsonArtifact(args.sourceManifest);
  const source = sourceArtifact === null ? null : parseSourceManifest(sourceArtifact.value);
  if (source !== null && dump !== null) {
    validateArtifactBindings({ dump: { ...dump, bytes: String(dump.bytes) }, source });
  }
  if (source !== null) {
    sameArtifact(source.companions.migration, artifactIdentity(manifestPath));
    if (args.dlq !== null) sameArtifact(source.companions.dlq, artifactIdentity(args.dlq));
  }
  if (args.restoreEvidence !== null) {
    const receiptArtifact = readJsonArtifact(args.restoreEvidence);
    const receipt = parseRestoreReceipt(receiptArtifact.value);
    if (dump !== null && receipt.dump?.sha256 !== dump.sha256) {
      throw new Error(
        `restore evidence dump.sha256=${receipt.dump?.sha256} differs from dump.sha256=${dump.sha256}`,
      );
    }
    if (receipt.kind !== 'legacy-limited') {
      if (receipt.kind === 'failed') throw new Error('recorded restore failure');
      if (receipt.kind === 'verified') {
        if (source === null || sourceArtifact === null || dump === null)
          throw new Error('current parity requires dump and --source-manifest');
        const quiescence = readJsonArtifact(
          args.quiescenceEvidence ?? source.quiescence.artifact.file,
        );
        const evidence = quiescenceEvidenceSchema.parse(quiescence.value);
        validateArtifactBindings({
          dump: { ...dump, bytes: String(dump.bytes) },
          source,
          sourceArtifact: sourceArtifact.identity,
          receipt,
          quiescenceArtifact: quiescence.identity,
          quiescence: evidence,
          executionArtifacts: validateExecutionArtifacts(evidence),
        });
      }
    }
    restoreEvidence = {
      ...receipt,
      file: receiptArtifact.identity.file,
      sha256: receiptArtifact.identity.sha256,
      bytes: Number(receiptArtifact.identity.bytes),
    };
    if (!receipt.verified)
      warnings.push('restore_evidence_unverified: limited historical or SQL-only evidence');
  } else warnings.push('missing_restore_evidence: current parity has not been established');
  if (args.requireRestoreParity && restoreEvidence?.kind !== 'verified') {
    throw new Error(
      '--require-restore-parity needs a current successful receipt, dump and source manifest',
    );
  }

  const manifest = buildCutoverBackupManifest({
    migration_manifest: migration,
    dump,
    dlq_export: dlqExport,
    dlq_observed: dlqObserved,
    job_epoch_disposition: { ...JOB_EPOCH_DISPOSITION },
    code_contract_epoch: CODE_CONTRACT_EPOCH,
    assessment_contract_epoch: ASSESSMENT_CONTRACT_EPOCH,
    restore_evidence: restoreEvidence,
    git_sha: args.gitSha ?? currentGitSha(),
  });
  return { manifest, warnings };
}

export function runCutoverBackup(args: CutoverBackupArgs): {
  outFile: string;
  warnings: string[];
} {
  if (args.out === null) {
    throw new Error('missing --out=<dir>');
  }
  const outDir = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  try {
    const { manifest, warnings } = buildManifest(args);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = join(outDir, `cutover-manifest-${stamp}.json`);
    atomicWrite(outFile, `${stableStringify(manifest)}\n`);
    atomicWrite(
      join(outDir, 'cutover-latest.json'),
      `${JSON.stringify({ manifest_file: outFile.split('/').pop(), captured_at: manifest.captured_at }, null, 2)}\n`,
    );
    return { outFile, warnings };
  } catch (error) {
    const failureFile = join(outDir, `cutover-failed-${randomUUID()}.json`);
    atomicWrite(
      failureFile,
      JSON.stringify({
        format: 'loom-cutover-assembly-failure',
        version: 2,
        kind: 'failed',
        verified: false,
        errors: errorDetails(error, 'manifest'),
      }),
    );
    atomicWrite(
      join(outDir, 'cutover-latest.json'),
      JSON.stringify({
        kind: 'failed',
        failure_file: failureFile,
        finished_at: new Date().toISOString(),
      }),
    );
    throw error;
  }
}

export const CUT_OVER_REQUIRED = ['manifest', 'dump', 'dlq'] as const;

export function requiredMissing(args: CutoverBackupArgs): string[] {
  const missing: string[] = [];
  if (args.captureDir === null && args.manifest === null) missing.push('manifest');
  if (args.dump === null) missing.push('dump');
  if (args.dlq === null) missing.push('dlq');
  return missing;
}

const migrationManifestBoundary: z.ZodType<MigrationManifest> = z.object({
  manifest_version: z.literal(1),
  tool: z.object({ name: z.literal('migration-capture'), version: z.string() }),
  checkpoint_hash: z.string(),
  source: z.object({
    git_sha: z.string().nullable(),
    app_image: z.string().nullable(),
    worker_image: z.string().nullable(),
    captured_at: z.string(),
    isolation: z.literal('repeatable read read only'),
    db: z.object({
      server_version: z.string(),
      database_name: z.string(),
      host_fingerprint: z.string(),
      migrations_applied: z.number().nullable(),
      migration_files: z.number().nullable(),
      migration_drift: z.enum(['unknown', 'in_sync', 'drift']),
    }),
    pgboss_schema_present: z.boolean(),
  }),
  redaction: z.object({ applied: z.boolean(), fields: z.array(z.string()) }),
  semantic_counts: z.array(
    z.object({
      table: z.string(),
      rows: z.number(),
      pks: z.array(z.string()).nullable(),
      pk_digest: z.string(),
      truncated: z.boolean(),
    }),
  ),
  event_action_counts: z.array(z.object({ action: z.string(), count: z.number() })),
  raw_fact_hash: z.object({
    canonical: z.string(),
    per_partition: z.record(z.string(), z.string()),
  }),
  edge_hash: z.object({ digest: z.string(), edge_count: z.number() }),
  mutable_ops_fields: z.object({
    excluded_from_fact_hash: z.array(z.string()),
    event_ingest_at_present: z.number(),
    state_updated_at_max: z.record(z.string(), z.string().nullable()),
    state_version_max: z.record(z.string(), z.number().nullable()),
  }),
  projection_baseline: z.record(z.string(), z.number()),
  queues: z.object({
    pgboss_schema_present: z.boolean(),
    by_name_state: z.array(z.object({ name: z.string(), state: z.string(), count: z.number() })),
    dlq_total: z.number(),
  }),
  subscriptions: z.object({
    checkpoints: z.array(
      z.object({
        subscriber_id: z.string(),
        subscriber_version: z.number(),
        status: z.string(),
        next_delivery_seq: z.number(),
      }),
    ),
    delivery_by_status: z.array(
      z.object({ subscriber_id: z.string(), status: z.string(), count: z.number() }),
    ),
  }),
  blobs: z.object({
    source_assets: z.array(
      z.object({
        id: z.string(),
        sha256: z.string(),
        byte_size: z.number(),
        mime_type: z.string(),
      }),
    ),
    source_documents: z.number(),
    question_image_refs_total: z.number(),
    answer_image_refs_total: z.number(),
  }),
  classification: z.object({
    classification_version: z.string(),
    classification_hash: z.string(),
    records: z.array(
      z.object({
        category: z.enum([
          'complete_attempt',
          'embedded_tutor_grade',
          'attribution_only',
          'attribution_pending_placeholder',
          'human_import_assertion',
          'pending_blocked',
          'pending_resolved_lineage',
          'live_draft',
          'historical_unresolved',
          'correction_cycle_unresolved',
          'fsrs_review_lineage',
          'state_snapshot_lineage',
          'causal_closure_lineage',
        ]),
        source_kind: z.enum(['event', 'answer']),
        source_id: z.string(),
        source_locator: z.string(),
        reason: z.string(),
        evidence_event_ids: z.array(z.string()),
        native_target: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('submission_with_imported_eval'),
            judge_event_id: z.string().nullable(),
            has_effective_head: z.boolean(),
            head_selection: z.enum([
              'sole_verdict',
              'legacy_newest_judge',
              'not_selected',
              'ambiguous_held',
            ]),
          }),
          z.object({
            kind: z.literal('submission_with_embedded_eval'),
            provenance: z.literal('embedded_tutor'),
          }),
          z.object({ kind: z.literal('attribution_evidence_only') }),
          z.object({
            kind: z.literal('manual_provenance_only'),
            assertion: z.enum(['human', 'import']),
          }),
          z.object({ kind: z.literal('pending_carried'), pending: PendingState }),
          z.object({ kind: z.literal('draft_preserved') }),
          z.object({ kind: z.literal('historical_unknown'), record: HistoricalUnknownSubmission }),
          z.object({ kind: z.literal('unresolved_correction_cycle') }),
          z.object({ kind: z.literal('lineage_only') }),
        ]),
      }),
    ),
    unresolved: z.array(
      z.object({
        source_kind: z.string(),
        source_id: z.string(),
        source_locator: z.string(),
        reason: z.string(),
      }),
    ),
    deferred_replay: z.array(
      z.object({
        source_kind: z.enum(['correction_cycle', 'reproject_deferred_marker']),
        source_id: z.string(),
        affected_subject_ids: z.array(z.string()),
        reason: z.string(),
      }),
    ),
  }),
  classification_rollup: z.record(z.string(), z.number()),
  unresolved_count: z.number(),
  deferred_replay_count: z.number(),
  completeness: z.object({
    max_dispatch_seq: z.number().nullable(),
    captured_event_rows: z.number(),
    note: z.string(),
    snapshot_at: z.string(),
  }),
});

const relationKey = (v: { schema: string; name: string }) => JSON.stringify([v.schema, v.name]);
function uniqueSet<T>(values: T[], key: (v: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const k = key(value);
    if (result.has(k)) throw new Error('duplicate inventory entry');
    result.set(k, value);
  }
  return result;
}
export function parseDatabaseManifest(value: unknown): DatabaseManifest {
  const m = databaseManifestSchema.parse(value);
  uniqueSet(m.schemas, (v) => v);
  uniqueSet(m.tables, relationKey);
  uniqueSet(m.sequences, relationKey);
  uniqueSet(m.extensions, (v) => v.name);
  for (const relation of [...m.tables, ...m.sequences]) {
    if (!m.schemas.includes(relation.schema)) throw new Error('relation missing schema');
  }
  for (const table of m.tables) {
    uniqueSet(table.columns, (v) => v.name);
    uniqueSet(table.parents, relationKey);
    if (table.kind === 'f' || table.persistence === 't') throw new Error('unsupported relation');
    if (table.kind === 'p' && table.rows !== '0')
      throw new Error('partition parent has local rows');
    for (const parent of table.parents)
      if (!m.tables.some((t) => relationKey(t) === relationKey(parent)))
        throw new Error('missing parent relation');
  }
  return {
    ...m,
    tables: m.tables.map(({ rows, sha256, ...table }) => ({
      ...canonicalTableMetadata(table),
      rows,
      sha256,
    })),
  };
}
export function parseSourceManifest(value: unknown): SourceManifest {
  const source = sourceManifestSchema.parse(value);
  source.inventory = parseDatabaseManifest(source.inventory);
  requireSameDatabase(source.source, source.quiescence.evidence.source);
  if (
    Date.parse(source.quiescence.evidence.established_at) > Date.parse(source.started_at) ||
    Date.parse(source.finished_at) < Date.parse(source.started_at)
  )
    throw new Error('invalid maintenance interval');
  let previousObservation = Date.parse(source.started_at);
  for (const observation of source.quiescence.observations) {
    const at = Date.parse(observation.at);
    if (at < previousObservation || at > Date.parse(source.finished_at))
      throw new Error('quiescence observations outside capture interval');
    previousObservation = at;
  }
  if (source.inventory.server_version !== source.source.server_version)
    throw new Error('source version mismatch');
  return source;
}
export function compareDatabaseManifests(options: {
  source: DatabaseManifest;
  restored: DatabaseManifest;
}): DatabaseComparison {
  const source = parseDatabaseManifest(options.source),
    restored = parseDatabaseManifest(options.restored);
  const a = uniqueSet(source.schemas, (v) => v),
    b = uniqueSet(restored.schemas, (v) => v);
  const compare = <T extends { schema: string; name: string }>(
    left: T[],
    right: T[],
    canonical: (value: T) => unknown = (value) => value,
  ) => {
    const l = uniqueSet(left, relationKey),
      r = uniqueSet(right, relationKey);
    const identity = (v: T) => ({ schema: v.schema, name: v.name });
    return {
      missing: left.filter((v) => !r.has(relationKey(v))).map(identity),
      extra: right.filter((v) => !l.has(relationKey(v))).map(identity),
      mismatched: left
        .filter(
          (v) =>
            r.has(relationKey(v)) &&
            stableStringify(canonical(v)) !==
              stableStringify(canonical(r.get(relationKey(v)) ?? v)),
        )
        .map(identity),
    };
  };
  const tables = compare(source.tables, restored.tables, (table) => ({
      ...table,
      parents: [...table.parents].sort((a, b) =>
        relationKey(a) < relationKey(b) ? -1 : relationKey(a) > relationKey(b) ? 1 : 0,
      ),
    })),
    sequences = compare(source.sequences, restored.sequences);
  const result: DatabaseComparison = {
    kind: 'equal',
    missing_schemas: source.schemas.filter((v) => !b.has(v)),
    extra_schemas: restored.schemas.filter((v) => !a.has(v)),
    missing_tables: tables.missing,
    extra_tables: tables.extra,
    mismatched_tables: tables.mismatched,
    missing_sequences: sequences.missing,
    extra_sequences: sequences.extra,
    mismatched_sequences: sequences.mismatched,
    environment_mismatches: [],
  };
  for (const key of ['algorithm', 'encoding', 'server_version', 'extensions'] as const) {
    const canonical = (value: (typeof source)[typeof key]) =>
      key === 'extensions' && Array.isArray(value)
        ? [...value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : value;
    if (stableStringify(canonical(source[key])) !== stableStringify(canonical(restored[key])))
      result.environment_mismatches.push(key);
  }
  if (Object.values(result).some((v) => Array.isArray(v) && v.length)) result.kind = 'different';
  return result;
}
export function parseRestoreReceipt(value: unknown): RestoreReceipt {
  const header = z
    .object({ format: z.unknown().optional(), version: z.unknown().optional() })
    .passthrough()
    .parse(value);
  if (header.format !== undefined || header.version !== undefined) {
    const receipt = currentRestoreReceiptSchema.parse(value);
    uniqueSet(receipt.phases, (v) => v.phase);
    if (receipt.source !== null) receipt.source = parseSourceManifest(receipt.source);
    if (receipt.restored !== null) receipt.restored = parseDatabaseManifest(receipt.restored);
    if (receipt.scratch.reopen) {
      const { reopen } = receipt.scratch;
      if (
        !/^loom-restore-drill-[a-f0-9-]{36}$/.test(receipt.scratch.container) ||
        receipt.source?.source.cluster === reopen.identity.cluster ||
        receipt.restored?.server_version !== reopen.identity.server_version
      )
        throw new Error('invalid retained reopen evidence');
    }
    if (receipt.kind === 'verified') {
      if (
        receipt.source === null ||
        receipt.restored === null ||
        receipt.dump === null ||
        receipt.source_manifest === null ||
        receipt.quiescence === null ||
        receipt.errors.length
      )
        throw new Error('incomplete verified receipt');
      for (const phase of REQUIRED_RESTORE_PHASES)
        if (!receipt.phases.some((p) => p.phase === phase && p.kind === 'ok'))
          throw new Error(`failed or missing phase: ${phase}`);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(receipt.scratch.image) ||
        receipt.scratch.image !== receipt.source.source_image
      )
        throw new Error('scratch image is not immutable');
      const comparison = compareDatabaseManifests({
        source: receipt.source.inventory,
        restored: receipt.restored,
      });
      if (
        comparison.kind !== 'equal' ||
        stableStringify(comparison) !== stableStringify(receipt.comparison)
      )
        throw new Error('forged comparison');
      if (stableStringify(receipt.quiescence) !== stableStringify(receipt.source.quiescence))
        throw new Error('quiescence receipt mismatch');
      validateArtifactBindings({ source: receipt.source, dump: receipt.dump });
    }
    if (receipt.kind === 'sql-restore-only') {
      const required = REQUIRED_RESTORE_PHASES.filter(
        (phase) => !['bindings', 'inspection', 'comparison'].includes(phase),
      );
      if (
        receipt.errors.length ||
        receipt.phases.some((phase) => phase.kind === 'failed') ||
        required.some(
          (phase) =>
            !receipt.phases.some((outcome) => outcome.phase === phase && outcome.kind === 'ok'),
        ) ||
        receipt.source !== null ||
        receipt.restored !== null ||
        receipt.source_manifest !== null ||
        receipt.quiescence !== null ||
        receipt.comparison !== null ||
        receipt.dump === null
      )
        throw new Error('invalid SQL-only receipt');
    }
    if (
      receipt.kind === 'failed' &&
      !receipt.errors.length &&
      !receipt.phases.some((phase) => phase.kind === 'failed')
    )
      throw new Error('failed receipt has no failure evidence');
    return receipt;
  }
  const legacy = z
    .object({
      verified: z.boolean().optional(),
      container: z.string().optional(),
      toc_entries: z.number().nullable().optional(),
      table_counts: z.record(z.string(), z.number()).optional(),
      dump: z
        .object({ sha256: z.string().optional(), toc_entries: z.number().nullable().optional() })
        .optional(),
    })
    .passthrough()
    .parse(value);
  return {
    kind: 'legacy-limited',
    level: 'legacy-limited',
    verified: false,
    reported_verified: legacy.verified ?? null,
    container: legacy.container ?? 'unknown',
    toc_entries: legacy.dump?.toc_entries ?? legacy.toc_entries ?? null,
    table_counts: legacy.table_counts ?? {},
    dump: legacy.dump ?? {},
    historical: value,
  };
}
export function readJsonArtifact(file: string): {
  value: unknown;
  identity: ArtifactIdentity;
  bytes: Buffer;
} {
  const bytes = readFileSync(file);
  return {
    value: JSON.parse(bytes.toString('utf8')),
    bytes,
    identity: {
      file: resolve(file),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: String(bytes.length),
    },
  };
}
export function artifactIdentity(file: string): ArtifactIdentity {
  return { file: resolve(file), sha256: sha256File(file), bytes: String(statSync(file).size) };
}
function sameArtifact(a: ArtifactIdentity, b: ArtifactIdentity): void {
  if (a.sha256 !== b.sha256 || a.bytes !== b.bytes)
    throw new Error(`artifact binding mismatch: ${a.sha256} / ${b.sha256}`);
}
export function validateArtifactBindings(options: {
  dump: ArtifactIdentity;
  source: SourceManifest;
  sourceArtifact?: ArtifactIdentity;
  receipt?: CurrentRestoreReceipt;
  quiescenceArtifact?: ArtifactIdentity;
  quiescence?: QuiescenceEvidence;
  executionArtifacts?: {
    runtime: { version: string; artifact: ArtifactIdentity };
    worker: ArtifactIdentity;
  };
}): void {
  sameArtifact(options.dump, options.source.dump);
  if (options.quiescenceArtifact)
    sameArtifact(options.quiescenceArtifact, options.source.quiescence.artifact);
  if (
    options.receipt &&
    options.source.quiescence.evidence.version === 2 &&
    (!options.quiescence || !options.quiescenceArtifact)
  )
    throw new Error('host quiescence artifact observations required');
  if (options.quiescence?.version === 2) {
    if (!options.executionArtifacts)
      throw new Error('host execution artifact observations required');
    sameArtifact(
      options.executionArtifacts.runtime.artifact,
      options.quiescence.execution.runtime.artifact,
    );
    sameArtifact(options.executionArtifacts.worker, options.quiescence.execution.worker.artifact);
    if (options.executionArtifacts.runtime.version !== options.quiescence.execution.runtime.version)
      throw new Error('host runtime version mismatch');
  }
  if (
    options.quiescence &&
    stableStringify(options.quiescence) !== stableStringify(options.source.quiescence.evidence)
  )
    throw new Error('quiescence bytes disagree');
  if (options.receipt) {
    if (
      !options.receipt.source_manifest ||
      !options.sourceArtifact ||
      !options.receipt.dump ||
      !options.receipt.source
    )
      throw new Error('missing receipt binding');
    sameArtifact(options.receipt.source_manifest, options.sourceArtifact);
    sameArtifact(options.receipt.dump, options.dump);
    if (stableStringify(options.receipt.source) !== stableStringify(options.source))
      throw new Error('source receipt mismatch');
    parseRestoreReceipt(options.receipt);
  }
}
/** File validation stays in the helper; the core schemas/parity parsers remain pure. */
export function validateExecutionArtifacts(
  evidence: QuiescenceEvidence,
): Parameters<typeof validateArtifactBindings>[0]['executionArtifacts'] {
  if (evidence.version === 1) return;
  const { runtime, worker } = evidence.execution;
  sameArtifact(artifactIdentity(runtime.artifact.file), runtime.artifact);
  const workerArtifact = artifactIdentity(worker.artifact.file);
  sameArtifact(workerArtifact, worker.artifact);
  // Host evidence is for the same pinned Node runtime used by capture and the parent worker.
  const runtimeArtifact = artifactIdentity(process.execPath);
  sameArtifact(runtimeArtifact, runtime.artifact);
  if (runtime.version !== process.version) throw new Error('host runtime version mismatch');
  return {
    runtime: { version: process.version, artifact: runtimeArtifact },
    worker: workerArtifact,
  };
}
function requireSameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): void {
  for (const k of [
    'cluster',
    'database_oid',
    'database',
    'server_version',
    'server_started_at',
    'in_recovery',
  ] as const)
    if (a[k] !== b[k]) throw new Error('source target identity mismatch');
}
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const qualified = (v: { schema: string; name: string }) =>
  `${quoteIdentifier(v.schema)}.${quoteIdentifier(v.name)}`;
const BUILTIN_OUTPUTS: Record<string, string> = {
  bool: 'boolout',
  int2: 'int2out',
  int4: 'int4out',
  int8: 'int8out',
  float4: 'float4out',
  float8: 'float8out',
  numeric: 'numeric_out',
  text: 'textout',
  varchar: 'varcharout',
  bpchar: 'bpcharout',
  name: 'nameout',
  bytea: 'byteaout',
  uuid: 'uuid_out',
  json: 'json_out',
  jsonb: 'jsonb_out',
  date: 'date_out',
  time: 'time_out',
  timetz: 'timetz_out',
  timestamp: 'timestamp_out',
  timestamptz: 'timestamptz_out',
  interval: 'interval_out',
  bit: 'bit_out',
  varbit: 'varbit_out',
  inet: 'inet_out',
  cidr: 'cidr_out',
  macaddr: 'macaddr_out',
  macaddr8: 'macaddr8_out',
  xml: 'xml_out',
  tsvector: 'tsvectorout',
  tsquery: 'tsqueryout',
  point: 'point_out',
  line: 'line_out',
  lseg: 'lseg_out',
  box: 'box_out',
  path: 'path_out',
  polygon: 'poly_out',
  circle: 'circle_out',
};
const BUILTIN_TYPES = new Set(Object.keys(BUILTIN_OUTPUTS));

function validateTypeChain(chain: TableMetadata['columns'][number]['type_chain']): void {
  uniqueSet(chain, relationKey);
  if (chain.slice(0, -1).some((type) => type.kind !== 'domain' && type.kind !== 'array'))
    throw new Error('invalid value type chain');
  for (const type of chain) {
    if (type.kind === 'builtin' && (type.schema !== 'pg_catalog' || !BUILTIN_TYPES.has(type.name)))
      throw new Error('unsupported value type');
    if (type.kind === 'enum') {
      if (!type.enum_labels.length) throw new Error('enum without labels');
      uniqueSet(type.enum_labels, (value) => value);
    }
    if (type.kind === 'vector' && type.name !== 'vector')
      throw new Error('unsupported extension type');
  }
  const terminal = chain.at(-1);
  if (!terminal || terminal.kind === 'domain' || terminal.kind === 'array')
    throw new Error('incomplete value type chain');
}
export function canonicalTableMetadata(value: TableMetadata): TableMetadata {
  const table = tableMetadataSchema.parse(value);
  return {
    ...table,
    columns: table.columns.map((column) => {
      validateTypeChain(column.type_chain);
      if (relationKey(column.type) !== relationKey(column.type_chain[0]))
        throw new Error('column type chain mismatch');
      // PG16 attndims describes declaration syntax, not the stored array value.
      // Domains can wrap arrays; array elements can themselves be domains.
      return {
        ...column,
        dimensions: column.type_chain.some((type) => type.kind === 'array') ? 0 : column.dimensions,
      };
    }),
  };
}
export function tableContentSql(table: TableMetadata): string {
  if (table.kind === 'f') throw new Error('foreign table not in pg_dump');
  const row = `json_build_array(${table.columns.map((c) => `${quoteIdentifier(c.name)}::text`).join(',')})::text`;
  return `COPY (SELECT h FROM (SELECT encode(sha256(convert_to(${row}, 'UTF8')), 'hex') AS h FROM ONLY ${qualified(table)}) AS rows ORDER BY h COLLATE "C") TO STDOUT;`;
}
export function createTableDigest(table: TableMetadata) {
  const hash = createHash('sha256').update(
    `${CONTENT_ALGORITHM}\n${stableStringify(canonicalTableMetadata(table).columns)}\n`,
  );
  let rows = 0n,
    pending = '',
    previous = '';
  return {
    update(chunk: Buffer | string) {
      if (Buffer.isBuffer(chunk) && chunk.some((byte) => byte > 127))
        throw new Error('non-ASCII table stream');
      const text = typeof chunk === 'string' ? chunk : chunk.toString('ascii');
      for (const char of text) {
        if (char === '\n') {
          if (!/^[a-f0-9]{64}$/.test(pending) || pending < previous)
            throw new Error('invalid or unsorted table stream');
          hash.update(`${pending}\n`, 'ascii');
          previous = pending;
          pending = '';
          rows++;
        } else {
          if (!/[a-f0-9]/.test(char) || pending.length >= 64)
            throw new Error('invalid table stream');
          pending += char;
        }
      }
    },
    finish() {
      if (pending) throw new Error('truncated table stream');
      return { rows: rows.toString(), sha256: hash.digest('hex') };
    },
  };
}

let interruptedSignal: NodeJS.Signals | null = null;
const activeProcesses = new Set<ChildProcess>();
class OperationFailure extends Error {
  constructor(
    readonly detail: RestoreError,
    readonly additional: RestoreError[] = [],
  ) {
    super(detail.message);
  }
}
function failure(phase: string, code: string, message: string): OperationFailure {
  return new OperationFailure({ phase, code, message });
}
function errorDetail(error: unknown, phase: string): RestoreError {
  return error instanceof OperationFailure
    ? error.detail
    : {
        phase,
        code: 'operation_failed',
        message: error instanceof Error ? error.message : 'unknown error',
      };
}
function errorDetails(error: unknown, phase: string): RestoreError[] {
  return error instanceof OperationFailure
    ? [error.detail, ...error.additional]
    : [errorDetail(error, phase)];
}
function subprocessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: process.env.HOME,
    npm_config_manage_package_manager_versions: 'false',
    npm_config_verify_deps_before_run: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    ...extra,
  };
}
type ProcessOutput =
  | { kind: 'text' }
  | { kind: 'file'; path: string }
  | { kind: 'digest'; digest: ReturnType<typeof createTableDigest> };
async function runProcess(options: {
  command: string;
  args: string[];
  phase: string;
  input?: string;
  inputFile?: string;
  output?: ProcessOutput;
  env?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}): Promise<string> {
  if (interruptedSignal && options.phase !== 'cleanup')
    throw new OperationFailure({
      phase: options.phase,
      code: 'interrupted',
      message: 'operation interrupted',
      signal: interruptedSignal,
    });
  const child = spawn(options.command, options.args, {
    shell: false,
    env: subprocessEnvironment(options.env),
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeProcesses.add(child);
  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once('error', () =>
        reject(failure(options.phase, 'spawn_failed', `${options.phase}: executable unavailable`)),
      );
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    },
  );
  // Do not retain SQL stderr: server errors can contain row values or credentials.
  child.stderr.resume();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 300_000);
  let bytes = 0,
    text = '';
  const decoder = new StringDecoder('utf8');
  const output = options.output ?? { kind: 'text' };
  const readOutput = async () => {
    if (output.kind === 'file') {
      await pipeline(child.stdout, createWriteStream(output.path, { flags: 'wx' }));
      return;
    }
    for await (const chunk of child.stdout) {
      const buffer = z.instanceof(Buffer).parse(chunk);
      if (output.kind === 'digest') output.digest.update(buffer);
      else {
        bytes += buffer.length;
        if (bytes > 32 * 1024 * 1024)
          throw failure(options.phase, 'output_limit', 'metadata output exceeded 32 MiB');
        text += decoder.write(buffer);
      }
    }
    if (output.kind === 'text') text += decoder.end();
  };
  const writeInput = async () => {
    if (options.inputFile) await pipeline(createReadStream(options.inputFile), child.stdin);
    else
      await new Promise<void>((resolveInput, reject) => {
        child.stdin.once('error', reject);
        child.stdin.end(options.input ?? '', resolveInput);
      });
  };
  try {
    const terminateOnError = (error: unknown) => {
      child.kill('SIGKILL');
      throw error;
    };
    const results = await Promise.allSettled([
      readOutput().catch(terminateOnError),
      writeInput().catch(terminateOnError),
      outcome,
    ]);
    const exit = results[2];
    if (exit.status === 'rejected') throw exit.reason;
    const readResult = results[0];
    if (readResult.status === 'rejected')
      throw failure(options.phase, 'stream_failed', 'subprocess output stream failed');
    if (exit.value.code !== 0 || timedOut)
      throw new OperationFailure({
        phase: options.phase,
        code: timedOut ? 'deadline_exceeded' : 'subprocess_failed',
        message: `${options.phase}: subprocess failed`,
        ...(exit.value.code === null ? {} : { exitCode: exit.value.code }),
        ...(exit.value.signal === null ? {} : { signal: exit.value.signal }),
      });
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return text;
  } finally {
    clearTimeout(timer);
    activeProcesses.delete(child);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
export interface DatabaseConnection {
  container: string;
  user: string;
  database: string;
  host?: string;
  scratchOwner?: ScratchOwner;
}
function psqlArgs(connection: DatabaseConnection): string[] {
  return [
    'exec',
    '-i',
    ...(connection.scratchOwner ? ['-e', 'PGPASSWORD=loom'] : []),
    connection.container,
    'psql',
    '-U',
    connection.user,
    '-d',
    connection.database,
    ...(connection.host ? ['-h', connection.host] : []),
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
  ];
}
export function inspectorTransaction(sql: string, snapshot?: string): string {
  if (snapshot && !/^[a-fA-F0-9]+-[a-fA-F0-9]+-[0-9]+$/.test(snapshot))
    throw new Error('invalid snapshot');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ${snapshot ? `SET TRANSACTION SNAPSHOT ${quoteLiteral(snapshot)};` : ''}
    SET LOCAL search_path=pg_catalog; SET LOCAL client_encoding='UTF8'; SET LOCAL TimeZone='UTC';
    SET LOCAL DateStyle='ISO,YMD'; SET LOCAL IntervalStyle='postgres'; SET LOCAL extra_float_digits=3;
    SET LOCAL bytea_output='hex'; SET LOCAL row_security=off; SET LOCAL work_mem='16MB';
    SET LOCAL temp_file_limit='1GB'; SET LOCAL statement_timeout='240s'; ${sql} COMMIT;`;
}
const NON_SYSTEM_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
export const IDENTITY_SQL = `SELECT json_build_object('cluster',(pg_control_system()).system_identifier::text,
  'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()), 'database',current_database(),
  'server_version',current_setting('server_version'),
  'server_started_at',to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'in_recovery',pg_is_in_recovery(), 'server_address',inet_server_addr()::text,'server_port',inet_server_port());`;
export const TYPES_SQL = `SELECT coalesce(json_agg(json_build_object('oid',t.oid::text,'schema',n.nspname,'name',t.typname,
  'kind',t.typtype,'category',t.typcategory,'base',t.typbasetype::text,'element',t.typelem::text,
  'modifier',t.typtypmod,'not_null',t.typnotnull,
  'extension',(SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e' LIMIT 1),
  'output',json_build_object('schema',opn.nspname,'name',op.proname),
  'labels',coalesce((SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=t.oid),'[]'::json)) ORDER BY t.oid),'[]'::json) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_proc op ON op.oid=t.typoutput JOIN pg_namespace opn ON opn.oid=op.pronamespace;`;
export const CATALOG_SQL = `SELECT json_build_object(
  'encoding',current_setting('server_encoding'),'server_version',current_setting('server_version'),
  'extensions',(SELECT coalesce(json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname),'[]'::json) FROM pg_extension),
  'schemas',(SELECT coalesce(json_agg(n.nspname ORDER BY n.nspname COLLATE "C"),'[]'::json) FROM pg_namespace n WHERE ${NON_SYSTEM_SCHEMA}),
  'tables',(SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,'partition',c.relispartition,
    'populated',c.relispopulated,'partition_bound',pg_get_expr(c.relpartbound,c.oid),
    'parents',coalesce((SELECT json_agg(json_build_object('schema',pn.nspname,'name',pc.relname) ORDER BY pn.nspname COLLATE "C",pc.relname COLLATE "C") FROM pg_inherits i JOIN pg_class pc ON pc.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE i.inhrelid=c.oid),'[]'::json),
    'columns',coalesce((SELECT json_agg(json_build_object('name',a.attname,'type_oid',a.atttypid::text,'type',json_build_object('schema',tn.nspname,'name',t.typname),'modifier',a.atttypmod,'dimensions',a.attndims,
      'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE json_build_object('schema',cn.nspname,'name',co.collname) END) ORDER BY a.attnum) FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::json)
    ) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${NON_SYSTEM_SCHEMA} AND c.relkind IN ('r','p','m','f')),
  'sequences',(SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname,
    'type',json_build_object('schema',tn.nspname,'name',t.typname), 'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
    'owner',(SELECT json_build_object('schema',onsp.nspname,'name',oc.relname,'column',a.attname) FROM pg_depend d JOIN pg_class oc ON oc.oid=d.refobjid JOIN pg_namespace onsp ON onsp.oid=oc.relnamespace JOIN pg_attribute a ON a.attrelid=oc.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i') LIMIT 1)
    ) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid JOIN pg_type t ON t.oid=s.seqtypid JOIN pg_namespace tn ON tn.oid=t.typnamespace WHERE ${NON_SYSTEM_SCHEMA}));`;
const rawTypeSchema = z.object({
  oid: z.string(),
  schema: z.string(),
  name: z.string(),
  kind: z.string(),
  category: z.string(),
  base: z.string(),
  element: z.string(),
  modifier: z.number().int(),
  not_null: z.boolean(),
  extension: z.string().nullable(),
  labels: z.array(z.string()),
  output: z.object({ schema: z.string(), name: z.string() }),
});
const rawColumnSchema = tableMetadataSchema.shape.columns.element
  .omit({ type_chain: true })
  .extend({ type_oid: z.string() });
const rawCatalogSchema = databaseManifestSchema
  .omit({ algorithm: true, tables: true, sequences: true })
  .extend({
    tables: z.array(
      tableMetadataSchema
        .omit({ columns: true })
        .extend({ populated: z.boolean(), columns: z.array(rawColumnSchema) }),
    ),
    sequences: z.array(sequenceManifestSchema.omit({ last_value: true, is_called: true })),
  });
export function resolveTypeChain(
  oid: string,
  raw: unknown,
): TableMetadata['columns'][number]['type_chain'] {
  return resolveCatalogTypeChain(oid, parseTypeCatalog(raw));
}
function parseTypeCatalog(raw: unknown) {
  return uniqueSet(z.array(rawTypeSchema).parse(raw), (t) => t.oid);
}
function resolveCatalogTypeChain(
  oid: string,
  types: ReturnType<typeof parseTypeCatalog>,
): TableMetadata['columns'][number]['type_chain'] {
  const visited = new Set<string>();
  const chain: TableMetadata['columns'][number]['type_chain'] = [];
  let current = oid;
  while (true) {
    const t = types.get(current);
    if (!t || visited.has(current)) throw new Error('missing or recursive type');
    visited.add(current);
    let kind: TableMetadata['columns'][number]['type_chain'][number]['kind'];
    if (t.kind === 'd') kind = 'domain';
    else if (t.category === 'A' && t.element !== '0') kind = 'array';
    else if (t.kind === 'e') kind = 'enum';
    else if (t.kind === 'b' && t.extension === 'vector' && t.name === 'vector') kind = 'vector';
    else if (t.kind === 'b' && t.schema === 'pg_catalog' && BUILTIN_TYPES.has(t.name))
      kind = 'builtin';
    else throw new Error(`unsupported type ${qualified(t)}`);
    if (
      kind === 'builtin' &&
      (t.output.schema !== 'pg_catalog' || t.output.name !== BUILTIN_OUTPUTS[t.name])
    )
      throw new Error('unsupported builtin output');
    if (kind === 'array' && (t.output.schema !== 'pg_catalog' || t.output.name !== 'array_out'))
      throw new Error('unsupported array output');
    if (kind === 'enum' && (t.output.schema !== 'pg_catalog' || t.output.name !== 'enum_out'))
      throw new Error('unsupported enum output');
    if (kind === 'vector' && (t.output.schema !== t.schema || t.output.name !== 'vector_out'))
      throw new Error('unsupported vector output');
    if (kind === 'domain') {
      const base = types.get(t.base);
      if (!base || relationKey(base.output) !== relationKey(t.output))
        throw new Error('unsupported domain output');
    }
    chain.push({
      schema: t.schema,
      name: t.name,
      kind,
      enum_labels: t.labels,
      domain_not_null: t.not_null,
      modifier: t.modifier,
    });
    if (kind === 'domain') current = t.base;
    else if (kind === 'array') current = t.element;
    else break;
  }
  validateTypeChain(chain);
  return chain;
}
async function databaseJson(
  connection: DatabaseConnection,
  sql: string,
  phase: string,
  snapshot?: string,
): Promise<unknown> {
  if (connection.scratchOwner) await verifyScratch(connection.scratchOwner, phase);
  const output = await runProcess({
    command: 'docker',
    args: [...psqlArgs(connection), '-c', inspectorTransaction(sql, snapshot)],
    phase,
  });
  try {
    return JSON.parse(output);
  } catch {
    throw failure(phase, 'invalid_query_json', 'query did not return valid JSON');
  }
}
async function catalog(connection: DatabaseConnection, snapshot?: string) {
  return rawCatalogSchema.parse(await databaseJson(connection, CATALOG_SQL, 'inventory', snapshot));
}
async function sequences(
  connection: DatabaseConnection,
  entries: z.infer<typeof rawCatalogSchema>['sequences'],
  snapshot?: string,
) {
  const result: DatabaseManifest['sequences'] = [];
  for (const sequence of entries) {
    const state = z
      .object({ last_value: sequenceManifestSchema.shape.last_value, is_called: z.boolean() })
      .parse(
        await databaseJson(
          connection,
          `SELECT json_build_object('last_value',last_value::text,'is_called',is_called) FROM ${qualified(sequence)};`,
          'sequence',
          snapshot,
        ),
      );
    result.push({ ...sequence, ...state });
  }
  return result;
}
async function checkSortSpace(connection: DatabaseConnection): Promise<void> {
  if (connection.scratchOwner) await verifyScratch(connection.scratchOwner, 'sort-space');
  const output = await runProcess({
    command: 'docker',
    args: ['exec', connection.container, 'sh', '-c', 'df -Pk "$PGDATA"'],
    phase: 'sort-space',
  });
  const fields = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
  const available = fields?.at(-3);
  if (!available || !/^[0-9]+$/.test(available) || BigInt(available) < 65536n)
    throw failure(
      'sort-space',
      'insufficient_sort_space',
      'at least 64 MiB available sort space is required',
    );
}
export async function inspectDatabase(options: {
  connection: DatabaseConnection;
  snapshot?: string;
}): Promise<DatabaseManifest> {
  if (options.snapshot === undefined) {
    const keeper = await snapshotKeeper(options.connection);
    try {
      const result = await inspectDatabase({ ...options, snapshot: keeper.snapshot });
      keeper.assertAlive();
      await keeper.close();
      return result;
    } catch (error) {
      try {
        await keeper.close();
      } catch (cleanup) {
        throw new OperationFailure(
          errorDetail(error, 'inspection'),
          errorDetails(cleanup, 'cleanup'),
        );
      }
      throw error;
    }
  }
  const raw = await catalog(options.connection, options.snapshot);
  const types = parseTypeCatalog(
    await databaseJson(options.connection, TYPES_SQL, 'types', options.snapshot),
  );
  const tables: DatabaseManifest['tables'] = [];
  for (const entry of raw.tables) {
    if (entry.kind === 'f' || entry.persistence === 't' || (entry.kind === 'm' && !entry.populated))
      throw failure(
        'inventory',
        'unsupported_relation',
        `${qualified(entry)}: foreign, temporary or unpopulated materialized relation`,
      );
    const { populated: _populated, ...entryMetadata } = entry;
    const table = canonicalTableMetadata({
      ...entryMetadata,
      columns: entry.columns.map((c) => {
        const { type_oid, ...metadata } = c;
        return { ...metadata, type_chain: resolveCatalogTypeChain(type_oid, types) };
      }),
    });
    const digest = createTableDigest(table);
    if (table.kind !== 'p') {
      await checkSortSpace(options.connection);
      if (options.connection.scratchOwner)
        await verifyScratch(options.connection.scratchOwner, 'table-stream');
      await runProcess({
        command: 'docker',
        args: [
          ...psqlArgs(options.connection),
          '-c',
          inspectorTransaction(tableContentSql(table), options.snapshot),
        ],
        phase: 'table-stream',
        output: { kind: 'digest', digest },
      });
    }
    tables.push({ ...table, ...digest.finish() });
  }
  return parseDatabaseManifest({
    algorithm: CONTENT_ALGORITHM,
    encoding: raw.encoding,
    server_version: raw.server_version,
    extensions: raw.extensions,
    schemas: raw.schemas,
    tables,
    sequences: await sequences(options.connection, raw.sequences, options.snapshot),
  });
}

async function databaseIdentity(connection: DatabaseConnection): Promise<DatabaseIdentity> {
  return databaseIdentitySchema.parse(await databaseJson(connection, IDENTITY_SQL, 'identity'));
}
export async function hostDatabaseIdentity(target: string): Promise<DatabaseIdentity> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw failure('identity', 'invalid_target', 'invalid source target URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2 ||
    !url.username ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length > 1 ||
    (url.searchParams.has('sslmode') &&
      !['disable', 'prefer', 'require', 'verify-full'].includes(
        url.searchParams.get('sslmode') ?? '',
      ))
  )
    throw failure('identity', 'invalid_target', 'explicit PostgreSQL host and database required');
  // No application database module or environment-derived connection is imported.
  const { default: postgres } = await import('postgres');
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres({
      host: url.hostname,
      port: Number(url.port || '5432'),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: () => decodeURIComponent(url.password),
      ssl:
        sslmode === 'disable'
          ? false
          : sslmode === 'prefer'
            ? 'prefer'
            : sslmode === 'require'
              ? 'require'
              : 'verify-full',
      max: 1,
      prepare: false,
      fetch_types: false,
      connect_timeout: 5,
      idle_timeout: 1,
      max_lifetime: 20,
      keep_alive: 0,
      backoff: () => 0,
      target_session_attrs: 'primary',
      debug: false,
      onnotice: () => {},
      connection: {
        application_name: 'loom-cutover-readonly-identity',
        default_transaction_read_only: true,
        statement_timeout: 10_000,
        lock_timeout: 5_000,
      },
    });
  } catch {
    throw failure('host-identity', 'driver_failed', 'explicit target identity client failed');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let identity: DatabaseIdentity | undefined;
  const errors: RestoreError[] = [];
  let abort: (signal: NodeJS.Signals) => void = () => {};
  const onInt = () => abort('SIGINT'),
    onTerm = () => abort('SIGTERM');
  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = (signal) =>
        reject(
          new OperationFailure({
            phase: 'host-identity',
            code: 'interrupted',
            message: 'identity operation interrupted',
            signal,
          }),
        );
      timer = setTimeout(
        () => reject(failure('host-identity', 'deadline_exceeded', 'identity deadline exceeded')),
        15_000,
      );
    });
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    if (interruptedSignal) abort(interruptedSignal);
    identity = await Promise.race([
      sql.begin('isolation level repeatable read read only', async (transaction) => {
        const rows = await transaction.unsafe(IDENTITY_SQL).values();
        return z
          .array(z.tuple([databaseIdentitySchema]))
          .length(1)
          .parse(rows)[0][0];
      }),
      cancellation,
    ]);
  } catch (error) {
    errors.push(
      ...errorDetails(
        error instanceof OperationFailure
          ? error
          : failure('host-identity', 'driver_failed', 'explicit target identity query failed'),
        'host-identity',
      ),
    );
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sql.end({ timeout: 1 }),
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(() => reject(new Error('close deadline')), 2_000);
        }),
      ]);
    } catch {
      errors.push(
        failure('host-identity', 'driver_cleanup_failed', 'identity client close failed').detail,
      );
    } finally {
      clearTimeout(closeTimer);
    }
  }
  if (errors.length) throw new OperationFailure(errors[0], errors.slice(1));
  if (!identity) throw failure('host-identity', 'driver_failed', 'identity result missing');
  return identity;
}
async function immutableImage(container: string): Promise<string> {
  const value: unknown = JSON.parse(
    await runProcess({
      command: 'docker',
      args: ['inspect', '--format', '{{json .Image}}', container],
      phase: 'image',
    }),
  );
  return z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(value);
}
// Launchers do not execute application/replication writes. Active transactions still fail.
// Replication workers, WAL senders, parallel/extension workers and all client sessions are unowned.
export function boundarySessionSql(keeperPid?: number): string {
  return `SELECT json_build_object('visible',(SELECT rolsuper OR pg_has_role(current_user,'pg_read_all_stats','MEMBER') FROM pg_roles WHERE rolname=current_user),
    'prepared',(SELECT count(*)::text FROM pg_prepared_xacts),
    'unowned',(SELECT count(*)::text FROM pg_stat_activity WHERE pid <> pg_backend_pid() ${keeperPid === undefined ? '' : `AND pid <> ${keeperPid}`} AND
      (backend_type NOT IN ('autovacuum launcher','autovacuum worker','background writer','checkpointer','walwriter','logical replication launcher','archiver') OR xact_start IS NOT NULL)));`;
}
async function observeBoundary(
  connection: DatabaseConnection,
  evidence: QuiescenceEvidence,
  keeperPid?: number,
) {
  validateExecutionArtifacts(evidence);
  for (const writer of evidence.writers) {
    if (writer.kind === 'container') {
      if (writer.id === connection.container)
        throw failure(
          'quiescence',
          'source_is_writer',
          'source container listed as a stopped writer',
        );
      const state = z
        .object({
          Running: z.boolean(),
          Restarting: z.boolean(),
          Status: z.string(),
        })
        .parse(
          JSON.parse(
            await runProcess({
              command: 'docker',
              args: ['inspect', '--format', '{{json .State}}', writer.id],
              phase: 'writer-state',
            }),
          ),
        );
      if (state.Running || state.Restarting || !['exited', 'created'].includes(state.Status))
        throw failure('quiescence', 'writer_running', 'writer observed running or not stopped');
    }
  }
  const observed = z
    .object({
      visible: z.boolean(),
      prepared: z.string().regex(/^(0|[1-9][0-9]*)$/),
      unowned: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .parse(await databaseJson(connection, boundarySessionSql(keeperPid), 'quiescence'));
  if (!observed.visible)
    throw failure('quiescence', 'insufficient_visibility', 'cannot inspect all sessions');
  if (observed.prepared !== '0')
    throw failure(
      'quiescence',
      'prepared_transactions_present',
      'prepared transactions prevent capture',
    );
  if (observed.unowned !== '0')
    throw failure(
      'quiescence',
      'unowned_sessions',
      'unowned client or writing/background session prevents capture',
    );
  return {
    at: new Date().toISOString(),
    sessions: 'no-unowned-clients',
    prepared_transactions: 'none',
    containers: 'stopped',
  } satisfies SourceManifest['quiescence']['observations'][number];
}
async function snapshotKeeper(connection: DatabaseConnection) {
  if (connection.scratchOwner) await verifyScratch(connection.scratchOwner, 'inspection');
  const child = spawn('docker', psqlArgs(connection), {
    shell: false,
    env: subprocessEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeProcesses.add(child);
  child.stderr.resume();
  let closed = false,
    controlled = false,
    acknowledged = false,
    buffer = '';
  const closeMarker = `loom_keeper_closed_${randomUUID()}`;
  let signalReady: ((value: { snapshot: string; pid: number }) => void) | undefined;
  let rejectReady: ((reason: unknown) => void) | undefined;
  const ready = new Promise<{ snapshot: string; pid: number }>((resolveReady, reject) => {
    signalReady = resolveReady;
    rejectReady = reject;
  });
  const outcome = new Promise<number | null>((resolveExit) => {
    child.once('error', () => {
      closed = true;
      activeProcesses.delete(child);
      rejectReady?.(failure('snapshot', 'keeper_spawn_failed', 'snapshot keeper unavailable'));
      resolveExit(null);
    });
    child.once('close', (code) => {
      closed = true;
      activeProcesses.delete(child);
      if (!controlled)
        rejectReady?.(failure('snapshot', 'keeper_closed_early', 'snapshot keeper closed early'));
      resolveExit(code);
    });
  });
  const timer = setTimeout(() => {
    rejectReady?.(failure('snapshot', 'keeper_deadline', 'snapshot export deadline'));
    child.kill('SIGKILL');
  }, 30_000);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (controlled) {
      if (buffer.trim() === closeMarker) acknowledged = true;
      else if (buffer.length > 4096 || buffer.includes('\n')) child.kill('SIGKILL');
      return;
    }
    if (buffer.length > 4096) {
      rejectReady?.(failure('snapshot', 'invalid_snapshot', 'invalid snapshot response'));
      child.kill('SIGKILL');
      return;
    }
    if (buffer.includes('\n')) {
      try {
        const value = z
          .strictObject({
            snapshot: sourceManifestSchema.shape.snapshot,
            pid: z.number().int().positive(),
          })
          .parse(JSON.parse(buffer.trim()));
        signalReady?.(value);
      } catch {
        rejectReady?.(failure('snapshot', 'invalid_snapshot', 'invalid snapshot response'));
        child.kill('SIGKILL');
      }
    }
  });
  child.stdin.on('error', () => {
    rejectReady?.(failure('snapshot', 'keeper_input_failed', 'snapshot keeper input failed'));
    child.kill('SIGKILL');
  });
  child.stdin.write(
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='30min'; SET LOCAL statement_timeout='30s'; SELECT json_build_object('snapshot',pg_export_snapshot(),'pid',pg_backend_pid());\n",
  );
  try {
    const value = await ready;
    clearTimeout(timer);
    return {
      ...value,
      assertAlive() {
        if (closed)
          throw failure('snapshot', 'keeper_closed_early', 'snapshot keeper closed early');
      },
      async close() {
        if (closed)
          throw failure('snapshot', 'keeper_closed_early', 'snapshot keeper closed early');
        controlled = true;
        buffer = '';
        child.stdin.end(`ROLLBACK; SELECT ${quoteLiteral(closeMarker)};\n`);
        const cleanupTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        try {
          if ((await outcome) !== 0 || !acknowledged)
            throw failure(
              'snapshot',
              'keeper_cleanup_failed',
              'snapshot keeper did not close cleanly',
            );
        } finally {
          clearTimeout(cleanupTimer);
        }
      },
    };
  } catch (error) {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await outcome;
    throw error;
  }
}
function tocCount(text: string): number {
  const entries = text.split('\n').filter((line) => line.trim() && !line.startsWith(';'));
  if (entries.some((line) => !/^\d+;\s+\d+\s+\d+\s/.test(line)))
    throw failure('toc', 'invalid_toc', 'invalid pg_restore TOC output');
  return entries.length;
}
export async function captureParitySource(options: {
  connection: DatabaseConnection;
  target: string;
  out: string;
  quiescenceEvidence: string;
}): Promise<{ directory: string; sourceManifest: string; source: SourceManifest }> {
  mkdirSync(options.out, { recursive: true });
  const directory = mkdtempSync(join(resolve(options.out), 'capture-'));
  const started_at = new Date().toISOString();
  let keeper: Awaited<ReturnType<typeof snapshotKeeper>> | undefined;
  try {
    const quiescenceArtifact = readJsonArtifact(options.quiescenceEvidence);
    const evidence = quiescenceEvidenceSchema.parse(quiescenceArtifact.value);
    validateExecutionArtifacts(evidence);
    const retainedQuiescence = join(directory, 'quiescence-evidence.json');
    writeFileSync(retainedQuiescence, quiescenceArtifact.bytes, { flag: 'wx' });
    const quiescenceIdentity = { ...quiescenceArtifact.identity, file: retainedQuiescence };

    if (Date.parse(evidence.established_at) > Date.parse(started_at))
      throw failure(
        'quiescence',
        'quiescence_unestablished',
        'maintenance boundary starts after capture',
      );
    const source = await databaseIdentity(options.connection);
    requireSameDatabase(source, await hostDatabaseIdentity(options.target));
    requireSameDatabase(source, evidence.source);
    const image = await immutableImage(options.connection.container);
    const first = await observeBoundary(options.connection, evidence);
    const clientVersion = async (name: string) => {
      const value = (
        await runProcess({
          command: 'docker',
          args: ['exec', options.connection.container, name, '--version'],
          phase: 'client-version',
        })
      ).trim();
      if (!/\(PostgreSQL\) 16\./.test(value))
        throw failure('client-version', 'incompatible_client', 'PostgreSQL 16 clients required');
      return value;
    };
    const client_versions = {
      psql: await clientVersion('psql'),
      pg_dump: await clientVersion('pg_dump'),
      pg_restore: await clientVersion('pg_restore'),
    };
    keeper = await snapshotKeeper(options.connection);
    const inventory = await inspectDatabase({
      connection: options.connection,
      snapshot: keeper.snapshot,
    });
    keeper.assertAlive();
    const dumpPath = join(directory, 'database.dump');
    await runProcess({
      command: 'docker',
      args: [
        'exec',
        options.connection.container,
        'pg_dump',
        '-Fc',
        '-U',
        options.connection.user,
        '-d',
        options.connection.database,
        `--snapshot=${keeper.snapshot}`,
      ],
      phase: 'dump',
      output: { kind: 'file', path: dumpPath },
    });
    keeper.assertAlive();
    const toc_entries = tocCount(
      await runProcess({
        command: 'docker',
        args: ['exec', '-i', options.connection.container, 'pg_restore', '-l'],
        inputFile: dumpPath,
        phase: 'toc',
      }),
    );
    const dlqPath = join(directory, 'dlq-tombstones.json');
    const dlqText = await runProcess({
      command: 'docker',
      args: [
        ...psqlArgs(options.connection),
        '-c',
        inspectorTransaction(
          "SELECT coalesce(json_agg(j ORDER BY j.name,j.state,j.id),'[]'::json)::text FROM pgboss.job j WHERE j.state IN ('failed','retry','created','active','cancelled') OR right(j.name,4)='_dlq';",
          keeper.snapshot,
        ),
      ],
      phase: 'dlq',
    });
    writeFileSync(dlqPath, dlqText, { flag: 'wx' });
    readDlqExport(dlqPath);
    const migrationDirectory = join(directory, 'migration');
    await runProcess({
      command: 'node',
      args: [
        '--import',
        import.meta.resolve('tsx'),
        resolve('scripts/migration-capture.ts'),
        `--out=${migrationDirectory}`,
        `--git-sha=${currentGitSha() ?? ''}`,
      ],
      // Existing CLI loads cwd/.env. A fresh capture directory contains none, so no provider keys are loaded.
      cwd: directory,
      env: { DATABASE_URL: options.target, TSX_TSCONFIG_PATH: resolve('tsconfig.json') },
      phase: 'migration-capture',
    });
    keeper.assertAlive();
    const finalCatalog = await catalog(options.connection, keeper.snapshot);
    const finalSequences = await sequences(
      options.connection,
      finalCatalog.sequences,
      keeper.snapshot,
    );
    if (stableStringify(finalSequences) !== stableStringify(inventory.sequences))
      throw failure('quiescence', 'sequence_changed', 'sequence state changed during capture');
    // Re-read catalogs without importing the snapshot to observe committed DDL.
    const liveCatalog = await catalog(options.connection);
    if (stableStringify(liveCatalog) !== stableStringify(finalCatalog))
      throw failure('quiescence', 'catalog_changed', 'catalog changed during capture');
    const liveTypes = parseTypeCatalog(await databaseJson(options.connection, TYPES_SQL, 'types'));
    for (const table of liveCatalog.tables) {
      const captured = inventory.tables.find((entry) => relationKey(entry) === relationKey(table));
      if (!captured)
        throw failure('quiescence', 'catalog_changed', 'relation changed during capture');
      for (const column of table.columns) {
        const original = captured.columns.find((entry) => entry.name === column.name);
        if (
          !original ||
          stableStringify(resolveCatalogTypeChain(column.type_oid, liveTypes)) !==
            stableStringify(original.type_chain)
        )
          throw failure('quiescence', 'type_changed', 'logical type changed during capture');
      }
    }
    const last = await observeBoundary(options.connection, evidence, keeper.pid);
    keeper.assertAlive();
    const helper_revision = currentGitSha();
    if (helper_revision === null)
      throw failure('sealing', 'missing_revision', 'helper revision unavailable');
    const sourceManifest = join(directory, 'source-manifest.json');
    const result = parseSourceManifest({
      format: 'loom-db-source',
      version: 2,
      helper_revision,
      source,
      source_image: image,
      client_versions,
      snapshot: keeper.snapshot,
      started_at,
      finished_at: new Date().toISOString(),
      quiescence: {
        artifact: quiescenceIdentity,
        evidence,
        assurance: 'operator-attested-with-observations',
        observations: [first, last],
      },
      dump: artifactIdentity(dumpPath),
      toc_entries,
      inventory,
      companions: {
        basis: 'external-maintenance-boundary',
        dlq: artifactIdentity(dlqPath),
        migration: artifactIdentity(resolveManifestPath(migrationDirectory, null)),
      },
    });
    const sealed = `${JSON.stringify(result, null, 2)}\n`;
    keeper.assertAlive();
    await keeper.close();
    keeper = undefined;
    atomicWrite(sourceManifest, sealed); // Ready artifact is last, after clean keeper closure.
    return { directory, sourceManifest, source: result };
  } catch (error) {
    const errors = errorDetails(error, 'capture');
    if (keeper) {
      try {
        await keeper.close();
      } catch (cleanup) {
        errors.push(errorDetail(cleanup, 'cleanup'));
      }
      keeper = undefined;
    }
    atomicWrite(
      join(directory, 'capture-failed.json'),
      JSON.stringify({
        format: 'loom-db-capture-failure',
        version: 2,
        kind: 'failed',
        verified: false,
        started_at,
        finished_at: new Date().toISOString(),
        errors,
      }),
    );
    throw error;
  }
}

const REQUIRED_RESTORE_PHASES: RestorePhase[] = [
  'preflight',
  'staging',
  'bindings',
  'start',
  'toc',
  'restore',
  'inspection',
  'comparison',
  'cleanup',
];
export function finalizeRestoreEvidence(options: {
  receipt: CurrentRestoreReceipt;
  out: string;
}): number {
  const receipt = options.receipt;
  try {
    if (receipt.source && receipt.restored)
      receipt.comparison = compareDatabaseManifests({
        source: receipt.source.inventory,
        restored: receipt.restored,
      });
    if (
      receipt.comparison?.kind === 'different' &&
      !receipt.errors.some((error) => error.code === 'content_mismatch')
    )
      receipt.errors.push({
        phase: 'comparison',
        code: 'content_mismatch',
        message: 'source and scratch inventories differ',
      });
    const required =
      receipt.kind === 'sql-restore-only'
        ? REQUIRED_RESTORE_PHASES.filter(
            (p) => !['bindings', 'inspection', 'comparison'].includes(p),
          )
        : REQUIRED_RESTORE_PHASES;
    if (
      !receipt.errors.length &&
      required.every((p) => receipt.phases.some((v) => v.phase === p && v.kind === 'ok'))
    ) {
      const completed =
        receipt.kind === 'sql-restore-only'
          ? receipt
          : { ...receipt, kind: 'verified', level: 'database-content-parity', verified: true };
      const parsed = parseRestoreReceipt(completed);
      atomicWrite(options.out, `${JSON.stringify(parsed, null, 2)}\n`);
      return 0;
    }
  } catch (error) {
    receipt.errors.push(errorDetail(error, 'finalization'));
  }
  if (!receipt.errors.length)
    receipt.errors.push({
      phase: 'finalization',
      code: 'incomplete_phases',
      message: 'required phases did not complete',
    });
  delete receipt.scratch.reopen;
  const failed = currentRestoreReceiptSchema.parse({
    ...receipt,
    kind: 'failed',
    level: 'failed',
    verified: false,
  });
  atomicWrite(options.out, `${JSON.stringify(failed, null, 2)}\n`);
  return 1;
}
export const scratchAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('isolated') }),
  z.strictObject({
    kind: z.literal('retained-loopback'),
    port: z.number().int().min(1024).max(65535),
    database: z.string().regex(/^test_fork_[0-9]+$/),
  }),
]);
type ScratchAccess = z.infer<typeof scratchAccessSchema>;
const SCRATCH_ATTEMPT_LABEL = 'loom.restore-drill.attempt';
interface ScratchOwner {
  id: string;
  attempt: string;
  name: string;
  image: string;
  access: ScratchAccess;
  database: string;
  volumes: Array<{ name: string; destination: string }> | null;
}
async function verifyScratch(owner: ScratchOwner, phase: string) {
  const binding = z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable();
  const inspected = z
    .array(
      z.object({
        Id: z.string(),
        Name: z.string(),
        Image: z.string(),
        Config: z.object({
          Env: z.array(z.string()),
          Labels: z.record(z.string(), z.string()).nullable(),
          Volumes: z.record(z.string(), z.unknown()).nullable(),
        }),
        State: z.object({ Running: z.boolean(), Restarting: z.boolean() }),
        HostConfig: z.object({
          NetworkMode: z.string(),
          Binds: z.array(z.unknown()).nullable(),
          Mounts: z.array(z.unknown()).optional(),
          PortBindings: z.record(z.string(), binding).nullable(),
        }),
        NetworkSettings: z.object({ Ports: z.record(z.string(), binding) }),
        Mounts: z.array(
          z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() }),
        ),
      }),
    )
    .length(1)
    .parse(
      JSON.parse(await runProcess({ command: 'docker', args: ['inspect', owner.id], phase })),
    )[0];
  const portBindings = (ports: Record<string, z.infer<typeof binding>> | null) => {
    const published = Object.entries(ports ?? {}).filter(([, value]) => value?.length);
    return owner.access.kind === 'isolated'
      ? published.length === 0
      : published.length === 1 &&
          published[0][0] === '5432/tcp' &&
          published[0][1]?.length === 1 &&
          published[0][1][0].HostIp === '127.0.0.1' &&
          published[0][1][0].HostPort === String(owner.access.port);
  };
  if (
    inspected.Id !== owner.id ||
    inspected.Name !== `/${owner.name}` ||
    inspected.Image !== owner.image ||
    inspected.Config.Labels?.[SCRATCH_ATTEMPT_LABEL] !== owner.attempt ||
    (phase !== 'cleanup' && (!inspected.State.Running || inspected.State.Restarting)) ||
    inspected.HostConfig.NetworkMode !== (owner.access.kind === 'isolated' ? 'none' : 'bridge') ||
    !portBindings(inspected.HostConfig.PortBindings) ||
    !portBindings(inspected.NetworkSettings.Ports) ||
    (inspected.HostConfig.Binds?.length ?? 0) !== 0 ||
    (inspected.HostConfig.Mounts?.length ?? 0) !== 0 ||
    !['POSTGRES_USER=loom', 'POSTGRES_PASSWORD=loom', `POSTGRES_DB=${owner.database}`].every(
      (env) =>
        inspected.Config.Env.filter((value) => value.split('=')[0] === env.split('=')[0]).join() ===
        env,
    )
  )
    throw failure(
      phase,
      'scratch_identity_mismatch',
      'scratch ownership, image, database or mapping changed',
    );
  const volumes = inspected.Mounts.map((mount) => {
    if (
      mount.Type !== 'volume' ||
      !mount.Name ||
      !(mount.Destination in (inspected.Config.Volumes ?? {}))
    )
      throw failure(phase, 'scratch_storage_mismatch', 'scratch has unexpected storage');
    return { name: mount.Name, destination: mount.Destination };
  }).sort((a, b) => a.destination.localeCompare(b.destination));
  if (owner.volumes !== null && stableStringify(volumes) !== stableStringify(owner.volumes))
    throw failure(phase, 'scratch_storage_mismatch', 'scratch storage identity changed');
  owner.volumes = volumes;
}
export function parseScratchAccess(
  argv: string[],
  mode: { keep: boolean; listOnly: boolean; restoreOnly: boolean },
): ScratchAccess {
  const read = (key: string) => {
    const matches = argv.filter((value) => value === `--${key}` || value.startsWith(`--${key}=`));
    if (!matches.length) return null;
    if (
      matches.length !== 1 ||
      !matches[0].startsWith(`--${key}=`) ||
      !matches[0].slice(key.length + 3)
    )
      throw failure(
        'preflight',
        'invalid_scratch_options',
        'scratch options require one nonempty --key=value each',
      );
    return matches[0].slice(key.length + 3);
  };
  const port = read('scratch-loopback-port'),
    database = read('scratch-database');
  if (port === null && database === null) return { kind: 'isolated' };
  if (
    !port ||
    !database ||
    !/^[1-9][0-9]{3,4}$/.test(port) ||
    !mode.keep ||
    mode.listOnly ||
    mode.restoreOnly
  )
    throw failure(
      'preflight',
      'invalid_scratch_options',
      'paired scratch options require full parity and --keep',
    );
  return scratchAccessSchema.parse({ kind: 'retained-loopback', port: Number(port), database });
}
export async function runRestoreDrill(options: {
  dump: string | null;
  sourceManifest: string | null;
  quiescenceEvidence: string | null;
  out: string;
  image: string | null;
  restoreOnly: boolean;
  listOnly: boolean;
  keep: boolean;
  overwrite: boolean;
  scratchArgs?: string[];
}): Promise<number> {
  let out = resolve(options.out),
    stage: string | undefined,
    owner: ScratchOwner | undefined;
  const attempt = randomUUID();
  const receipt: CurrentRestoreReceipt = {
    format: 'loom-restore-drill',
    version: 2,
    ...(options.restoreOnly
      ? ({ kind: 'sql-restore-only', level: 'sql-restore-only', verified: false } satisfies Pick<
          Extract<CurrentRestoreReceipt, { kind: 'sql-restore-only' }>,
          'kind' | 'level' | 'verified'
        >)
      : ({ kind: 'failed', level: 'failed', verified: false } satisfies Pick<
          Extract<CurrentRestoreReceipt, { kind: 'failed' }>,
          'kind' | 'level' | 'verified'
        >)),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    dump: null,
    source_manifest: null,
    source: null,
    restored: null,
    quiescence: null,
    scratch: { container: `loom-restore-drill-${randomUUID()}`, image: '', retained: false },
    phases: [],
    comparison: null,
    errors: [],
  };
  let phase: RestorePhase = 'preflight';
  const ok = (value: RestorePhase) => receipt.phases.push({ phase: value, kind: 'ok' });
  try {
    mkdirSync(resolve(out, '..'), { recursive: true });
    if (existsSync(out)) {
      if (options.overwrite && statSync(out).isFile())
        renameSync(out, `${out}.previous-${randomUUID()}`);
      else {
        out = `${out}.failed-attempt-${randomUUID()}.json`;
        throw failure(
          'preflight',
          'receipt_exists',
          'receipt exists; use --overwrite to archive it before a new attempt',
        );
      }
    }
    if (!options.dump) throw failure('preflight', 'missing_dump', '--dump is required');
    const access = parseScratchAccess(options.scratchArgs ?? [], options);
    const database = access.kind === 'isolated' ? 'loom' : access.database;
    if (!options.restoreOnly && !options.listOnly && !options.sourceManifest)
      throw failure(
        'preflight',
        'missing_source_manifest',
        'full mode requires --source-manifest; legacy dumps require --restore-only',
      );
    if (options.restoreOnly && options.sourceManifest)
      throw failure('preflight', 'ambiguous_mode', 'restore-only cannot claim a source manifest');
    ok('preflight');
    phase = 'staging';
    stage = mkdtempSync(join(tmpdir(), 'loom-restore-drill-'));
    const stagedDump = join(stage, 'database.dump');
    copyFileSync(options.dump, stagedDump);
    receipt.dump = { ...artifactIdentity(stagedDump), file: resolve(options.dump) };
    ok('staging');
    if (!options.restoreOnly && !options.listOnly) {
      phase = 'bindings';
      if (!options.sourceManifest)
        throw failure('bindings', 'missing_source_manifest', 'source manifest missing');
      const artifact = readJsonArtifact(options.sourceManifest);
      receipt.source_manifest = artifact.identity;
      const source = parseSourceManifest(artifact.value);
      receipt.source = source;
      receipt.quiescence = source.quiescence;
      const quiescence = readJsonArtifact(
        options.quiescenceEvidence ?? source.quiescence.artifact.file,
      );
      const evidence = quiescenceEvidenceSchema.parse(quiescence.value);
      validateArtifactBindings({
        source,
        dump: receipt.dump,
        quiescenceArtifact: quiescence.identity,
        quiescence: evidence,
        executionArtifacts: validateExecutionArtifacts(evidence),
      });
      ok('bindings');
    }
    phase = 'start';
    const requested =
      options.image ??
      receipt.source?.source_image ??
      (options.restoreOnly || options.listOnly
        ? (process.env.LOOM_PG_IMAGE ?? 'pgvector/pgvector:0.8.2-pg16-bookworm')
        : null);
    if (!requested) throw failure('start', 'missing_image', 'compatible scratch image required');
    const imageValue: unknown = JSON.parse(
      await runProcess({
        command: 'docker',
        args: ['image', 'inspect', '--format', '{{json .Id}}', requested],
        phase: 'image',
      }),
    );
    const image = z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(imageValue);
    receipt.scratch.image = image;
    if (receipt.source && receipt.source.source_image !== image)
      throw failure('start', 'image_mismatch', 'scratch image differs from source image');
    if (options.listOnly) {
      phase = 'toc';
      const text = await runProcess({
        command: 'docker',
        args: ['run', '--pull=never', '--rm', '--network=none', '-i', image, 'pg_restore', '-l'],
        phase: 'toc',
        inputFile: stagedDump,
      });
      tocCount(text);
      process.stdout.write(text);
      // A TOC listing is deliberately not a restore receipt.
    } else {
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(
          (
            await runProcess({
              command: 'docker',
              args: [
                'run',
                '--pull=never',
                '-d',
                ...(access.kind === 'isolated'
                  ? ['--network=none']
                  : ['--network=bridge', '--publish', `127.0.0.1:${access.port}:5432`]),
                '--label',
                `${SCRATCH_ATTEMPT_LABEL}=${attempt}`,
                '--name',
                receipt.scratch.container,
                '-e',
                'POSTGRES_USER=loom',
                '-e',
                'POSTGRES_PASSWORD=loom',
                '-e',
                `POSTGRES_DB=${database}`,
                image,
              ],
              phase: 'start',
            })
          ).trim(),
        );
      const candidate: ScratchOwner = {
        id,
        attempt,
        name: receipt.scratch.container,
        image,
        access,
        database,
        volumes: null,
      };
      await verifyScratch(candidate, 'start');
      owner = candidate;
      receipt.scratch.ownership = { container_id: id, attempt, volumes: candidate.volumes ?? [] };
      const connection = {
        container: id,
        user: 'loom',
        database,
        host: '127.0.0.1',
        scratchOwner: owner,
      };
      let ready = false;
      for (let i = 0; i < 90; i++) {
        await verifyScratch(owner, 'start');
        try {
          await runProcess({
            command: 'docker',
            args: [...psqlArgs(connection), '-c', 'select 1'],
            phase: 'readiness',
            timeoutMs: 2000,
          });
          ready = true;
          break;
        } catch {
          if (interruptedSignal) throw failure('start', 'interrupted', 'operation interrupted');
          await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
        }
      }
      if (!ready)
        throw failure('start', 'readiness_failed', 'scratch PostgreSQL did not become ready');
      const initialIdentity = await databaseIdentity(connection);
      if (
        initialIdentity.database !== database ||
        initialIdentity.in_recovery ||
        (receipt.source &&
          (initialIdentity.cluster === receipt.source.source.cluster ||
            initialIdentity.server_version !== receipt.source.source.server_version))
      )
        throw failure('start', 'scratch_database_mismatch', 'scratch database identity is invalid');
      ok('start');
      phase = 'toc';
      await verifyScratch(owner, 'toc');
      const toc = await runProcess({
        command: 'docker',
        args: ['exec', '-i', connection.container, 'pg_restore', '-l'],
        phase: 'toc',
        inputFile: stagedDump,
      });
      const count = tocCount(toc);
      if (receipt.source && count !== receipt.source.toc_entries)
        throw failure('toc', 'toc_mismatch', 'TOC entry count differs');
      ok('toc');
      phase = 'restore';
      await verifyScratch(owner, 'restore');
      await runProcess({
        command: 'docker',
        args: [
          'exec',
          '-i',
          '-e',
          'PGPASSWORD=loom',
          connection.container,
          'pg_restore',
          '-U',
          connection.user,
          '-d',
          database,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--single-transaction',
          '--exit-on-error',
        ],
        phase: 'restore',
        inputFile: stagedDump,
      });
      requireSameDatabase(initialIdentity, await databaseIdentity(connection));
      ok('restore');
      if (!options.restoreOnly) {
        phase = 'inspection';
        receipt.restored = await inspectDatabase({ connection });
        const finalIdentity = await databaseIdentity(connection);
        requireSameDatabase(initialIdentity, finalIdentity);
        ok('inspection');
        phase = 'comparison';
        if (!receipt.source)
          throw failure('comparison', 'missing_source', 'source manifest unavailable');
        receipt.comparison = compareDatabaseManifests({
          source: receipt.source.inventory,
          restored: receipt.restored,
        });
        if (receipt.comparison.kind !== 'equal')
          throw failure('comparison', 'content_mismatch', 'source and scratch inventories differ');
        ok('comparison');
        if (access.kind === 'retained-loopback')
          receipt.scratch.reopen = {
            kind: 'retained-loopback-v1',
            container_id: id,
            host: '127.0.0.1',
            port: access.port,
            identity: { ...finalIdentity, in_recovery: false },
          };
      }
    }
  } catch (error) {
    receipt.errors.push(...errorDetails(error, phase));
    receipt.phases.push({ phase, kind: 'failed' });
  } finally {
    try {
      if (owner) {
        await verifyScratch(owner, 'cleanup');
        if (options.keep) {
          receipt.scratch.retained = true;
          if (receipt.scratch.reopen)
            requireSameDatabase(
              receipt.scratch.reopen.identity,
              await databaseIdentity({
                container: owner.id,
                user: 'loom',
                database: owner.database,
                host: '127.0.0.1',
                scratchOwner: owner,
              }),
            );
        } else
          await runProcess({
            command: 'docker',
            args: ['rm', '-f', '-v', owner.id],
            phase: 'cleanup',
            timeoutMs: 10_000,
          });
      }
      if (stage) rmSync(stage, { recursive: true });
      ok('cleanup');
    } catch (error) {
      receipt.errors.push(errorDetail(error, 'cleanup'));
      receipt.phases.push({ phase: 'cleanup', kind: 'failed' });
    }
    if (receipt.errors.length) delete receipt.scratch.reopen;
  }
  receipt.finished_at = new Date().toISOString();
  if (options.listOnly && !receipt.errors.length) return 0;
  return finalizeRestoreEvidence({ receipt, out });
}
function readOption(argv: string[], key: string): string | null {
  const equal = argv.find((value) => value.startsWith(`--${key}=`));
  if (equal !== undefined) return equal.slice(key.length + 3);
  const i = argv.indexOf(`--${key}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
async function main(argv: string[]): Promise<number> {
  const operation = readOption(argv, 'operation') ?? 'manifest';
  if (
    operation !== 'restore-drill' &&
    argv.some((value) => /^--scratch-(loopback-port|database)(=|$)/.test(value))
  )
    throw failure(
      'preflight',
      'invalid_scratch_options',
      'scratch options require restore-drill full parity',
    );
  switch (operation) {
    case 'restore-drill':
      return runRestoreDrill({
        dump: readOption(argv, 'dump'),
        sourceManifest: readOption(argv, 'source-manifest'),
        quiescenceEvidence: readOption(argv, 'quiescence-evidence'),
        out:
          readOption(argv, 'out') ??
          join(
            readOption(argv, 'dump')
              ? resolve(readOption(argv, 'dump') ?? '', '..')
              : process.cwd(),
            `restore-evidence-${randomUUID()}.json`,
          ),
        image: readOption(argv, 'image'),
        restoreOnly: argv.includes('--restore-only'),
        listOnly: argv.includes('--list-only'),
        keep: argv.includes('--keep'),
        overwrite: argv.includes('--overwrite'),
        scratchArgs: argv,
      });
    case 'capture-parity': {
      const out = readOption(argv, 'out'),
        target = readOption(argv, 'target'),
        quiescenceEvidence = readOption(argv, 'quiescence-evidence');
      if (!out || !target || !quiescenceEvidence) {
        const error = failure(
          'preflight',
          'missing_capture_arguments',
          'capture requires --out, --target and --quiescence-evidence',
        );
        if (out) {
          mkdirSync(out, { recursive: true });
          atomicWrite(
            join(out, `capture-failed-${randomUUID()}.json`),
            JSON.stringify({
              format: 'loom-db-capture-failure',
              version: 2,
              kind: 'failed',
              verified: false,
              errors: [error.detail],
            }),
          );
        }
        throw error;
      }
      const result = await captureParitySource({
        out,
        target,
        quiescenceEvidence,
        connection: {
          container: readOption(argv, 'container') ?? 'the-learning-project-postgres-1',
          user: readOption(argv, 'user') ?? 'loom',
          database: readOption(argv, 'database') ?? 'loom',
        },
      });
      const args = parseCutoverBackupArgs(argv);
      try {
        const built = runCutoverBackup({
          ...args,
          out: result.directory,
          captureDir: join(result.directory, 'migration'),
          manifest: null,
          dump: result.source.dump.file,
          dlq: result.source.companions.dlq.file,
          sourceManifest: result.sourceManifest,
          tocEntries: String(result.source.toc_entries),
        });
        atomicWrite(
          join(result.directory, 'OWNER-ACTIONS.txt'),
          'Hold the external maintenance boundary through capture completion; release it explicitly.\nRun scripts/restore-drill.sh --dump=database.dump --source-manifest=source-manifest.json --out=restore-evidence.json in this capture directory.\nRebuild cutover-backup.ts with --source-manifest, --restore-evidence and --require-restore-parity for the final restore gate. --strict only requires capture artifacts.\nPreserve DLQ records and held/unknown durable obligations; this helper never restarts writers.\n',
        );
        process.stdout.write(
          `${JSON.stringify({ directory: result.directory, source_manifest: result.sourceManifest, manifest: built.outFile })}\n`,
        );
      } catch (error) {
        renameSync(result.sourceManifest, `${result.sourceManifest}.incomplete`);
        atomicWrite(
          join(result.directory, 'capture-failed.json'),
          JSON.stringify({
            format: 'loom-db-capture-failure',
            version: 2,
            kind: 'failed',
            verified: false,
            errors: errorDetails(error, 'sealing'),
          }),
        );
        throw error;
      }
      return 0;
    }
    case 'manifest': {
      const args = parseCutoverBackupArgs(argv);
      if (args.strict && requiredMissing(args).length)
        throw new Error(`strict missing required: ${requiredMissing(args).join(', ')}`);
      const { outFile, warnings } = runCutoverBackup(args);
      process.stdout.write(`${JSON.stringify({ manifest: outFile, warnings })}\n`);
      return 0;
    }
    default:
      throw new Error('unknown cutover-backup operation');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal;
    for (const child of activeProcesses) child.kill('SIGKILL');
  };
  process.on('SIGINT', () => interrupt('SIGINT'));
  process.on('SIGTERM', () => interrupt('SIGTERM'));
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(errorDetail(error, 'cli'))}\n`);
      process.exitCode = 1;
    });
}
