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
//   --dlq          worker 启动自清前的 pgboss.job 导出（JSON 数组；行含
//                  name/state 字段即够用——本脚本按 *_dlq 聚合对账）。
//   --restore-evidence  restore-drill.sh 产出的 JSON 证据（可后补）。
//
// --strict：必备工件缺失（migration manifest / dump / dlq export）时 exit 1。
// 默认报告式：全部缺口进 warnings[] 落盘，exit 0 —— 试运行/演练可部分执行，
// 统一切换 runbook 的正式执行必须 --strict。

import './load-env';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '@/core/migration/canonical';
import {
  type CutoverBackupManifest,
  buildCutoverBackupManifest,
} from '@/core/migration/cutover-manifest';
import type { MigrationManifest } from '@/core/migration/types';
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
  };
}

function sha256File(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
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
  const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as { manifest_file?: string };
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
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) return { rows: parsed as DlqExportRow[] };
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    return { rows: (parsed as { rows: DlqExportRow[] }).rows };
  }
  throw new Error(`dlq export ${path} 不是 JSON 数组或 {rows:[]} 形状`);
}

export interface RestoreEvidenceShape {
  verified?: boolean;
  container?: string;
  toc_entries?: number | null;
  table_counts?: Record<string, number>;
  /** restore-drill.sh 记录的【被恢复工件】身份（绑定证据与当前 dump 的关键）。 */
  dump?: {
    file?: string;
    sha256?: string;
    bytes?: number;
    toc_entries?: number | null;
  };
  [k: string]: unknown;
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
  const migration = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
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
      toc_entries: args.tocEntries === null ? null : Number.parseInt(args.tocEntries, 10),
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
    warnings.push('missing_dlq_export: 无 --dlq —— worker 启动自清前必须归档 DLQ tombstone');
  }

  let restoreEvidence = null;
  if (args.restoreEvidence !== null) {
    if (!existsSync(args.restoreEvidence)) {
      throw new Error(`restore evidence 不存在: ${args.restoreEvidence}`);
    }
    const raw = JSON.parse(readFileSync(args.restoreEvidence, 'utf8')) as RestoreEvidenceShape;
    // P1-1：证据必须绑定【所选 dump】——restore-drill.sh 把被恢复工件写在 nested
    // dump.sha256；只凭顶层 verified=true 会允许「别的 dump 的演练」冒充当前备份。
    const evidenceDumpSha =
      typeof raw.dump?.sha256 === 'string' && raw.dump.sha256.length > 0 ? raw.dump.sha256 : null;
    if (dump !== null) {
      if (evidenceDumpSha === null) {
        throw new Error(
          `restore evidence ${args.restoreEvidence} 缺 nested dump.sha256，无法绑定所选 dump（dump.sha256=${dump.sha256}）`,
        );
      }
      if (evidenceDumpSha !== dump.sha256) {
        throw new Error(
          `restore evidence dump.sha256=${evidenceDumpSha} 与所选 dump 不符（dump.sha256=${dump.sha256}）—— 证据不属于当前备份`,
        );
      }
    }
    restoreEvidence = {
      file: resolve(args.restoreEvidence),
      sha256: sha256File(args.restoreEvidence),
      bytes: statSync(args.restoreEvidence).size,
      verified: raw.verified === true,
      container: typeof raw.container === 'string' ? raw.container : 'unknown',
      // toc_entries 优先取 nested dump.toc_entries（drill 的实际记录位置）。
      toc_entries:
        typeof raw.dump?.toc_entries === 'number'
          ? raw.dump.toc_entries
          : typeof raw.toc_entries === 'number'
            ? raw.toc_entries
            : null,
      table_counts:
        typeof raw.table_counts === 'object' && raw.table_counts !== null ? raw.table_counts : {},
    };
    if (restoreEvidence.verified !== true) {
      warnings.push('restore_evidence_unverified: 演练证据 verified≠true');
    }
  } else {
    warnings.push('missing_restore_evidence: restore 演练尚未执行/归档（owner 排期动作）');
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
  const { manifest, warnings } = buildManifest(args);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(outDir, `cutover-manifest-${stamp}.json`);
  atomicWrite(outFile, `${stableStringify(manifest)}\n`);
  atomicWrite(
    join(outDir, 'cutover-latest.json'),
    `${JSON.stringify({ manifest_file: outFile.split('/').pop(), captured_at: manifest.captured_at }, null, 2)}\n`,
  );
  return { outFile, warnings };
}

export const CUT_OVER_REQUIRED = ['manifest', 'dump', 'dlq'] as const;

export function requiredMissing(args: CutoverBackupArgs): string[] {
  const missing: string[] = [];
  if (args.captureDir === null && args.manifest === null) missing.push('manifest');
  if (args.dump === null) missing.push('dump');
  if (args.dlq === null) missing.push('dlq');
  return missing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCutoverBackupArgs(process.argv.slice(2));
  try {
    const { outFile, warnings } = runCutoverBackup(args);
    console.log(`[cutover-backup] manifest: ${outFile}`);
    for (const w of warnings) {
      console.warn(`[cutover-backup] warn: ${w}`);
    }
    if (args.strict && requiredMissing(args).length > 0) {
      console.error(
        `[cutover-backup] strict: missing required: ${requiredMissing(args).join(', ')}`,
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('[cutover-backup] failed:', err);
    process.exit(1);
  }
}
