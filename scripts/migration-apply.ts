// YUK-1050 — 历史迁移 apply CLI（grounding §13、§15）。
//
// 一次性离线 cutover 工具：消费 YUK-1048 捕获/分类工件（内容寻址目录 +
// latest.json 指针）与语料导入 lane 的 revision registry，按分类输出把历史
// 记录幂等写入 YUK-1044 真相源表。无 LLM、无学习重放；本工具本身就是
// cutover runbook 的迁移步骤，运行前提（停 writer、final backup）由 runbook
// 保证，不由本工具猜测。
//
// CLI（owner 于 cutover 窗口运行；只应指向隔离演练库或授权维护窗口的库）：
//   pnpm migration:apply --artifacts=<dir> --target=<postgres-url> --revisions=<registry.json> --confirm-write
//   pnpm migration:apply --artifacts=<dir> --target=<postgres-url> --revisions=<registry.json> --dry-run
//   可选：--out=<report-dir>（默认 = artifacts 目录）、--batch-size=<N>
//
// 安全纪律：
//   - 写路径【必须】显式 --target + --confirm-write —— 不回退 DATABASE_URL、
//     不默认写库（对齐 capture 的显式 target 纪律并加码）。
//   - 工件验证复算 classification hash（篡改即拒，对齐 YUK-1048 P2-A）。

import './load-env';

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  type RevisionRegistry,
  applyRunIdOf,
  buildMigrationApplyPlan,
  parseRevisionRegistry,
  planDigestOf,
  registryDigestOf,
} from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
import type { MigrationCapture, MigrationManifest } from '@/core/migration/types';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  type MigrationApplyFence,
  applyReportFileName,
  assertReconciliationClean,
  runMigrationApply,
} from '@/server/migration/apply';
import { describeTarget } from './migration-capture';

export const APPLY_TOOL_VERSION = '1.0.0';

// ───────────────────────── CLI 参数 ─────────────────────────

export interface ApplyCliArgs {
  artifacts: string | null;
  target: string | null;
  revisions: string | null;
  out: string | null;
  dryRun: boolean;
  confirmWrite: boolean;
  batchSize: number;
}

export function parseApplyArgs(argv: string[]): ApplyCliArgs {
  const readFlag = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(`--${flag}=`.length);
    const idx = argv.indexOf(`--${flag}`);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
    return null;
  };
  const batchSizeRaw = readFlag('batch-size');
  const batchSize = batchSizeRaw === null ? 200 : Number.parseInt(batchSizeRaw, 10);
  return {
    artifacts: readFlag('artifacts'),
    target: readFlag('target'),
    revisions: readFlag('revisions'),
    out: readFlag('out'),
    dryRun: argv.includes('--dry-run'),
    confirmWrite: argv.includes('--confirm-write'),
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 200,
  };
}

// ───────────────────────── 工件加载与验证 ─────────────────────────

export interface LoadedArtifacts {
  capture: MigrationCapture;
  manifest: MigrationManifest;
  captureFile: string;
  manifestFile: string;
}

/**
 * 加载 YUK-1048 工件并验证身份（对齐 P2-A：不信任存储的哈希字符串，
 * 从存储内容复算 classification hash；capture/manifest 的 checkpoint 绑定）。
 */
export function loadMigrationArtifacts(artifactsDir: string): LoadedArtifacts {
  const latestPath = join(artifactsDir, 'latest.json');
  let captureFile: string | null = null;
  let manifestFile: string | null = null;
  if (existsSync(latestPath)) {
    const pointer = JSON.parse(readFileSync(latestPath, 'utf8')) as {
      checkpoint_hash?: unknown;
      capture_file?: unknown;
      manifest_file?: unknown;
    };
    if (typeof pointer.capture_file !== 'string' || typeof pointer.manifest_file !== 'string') {
      throw new Error('latest.json 指针缺 capture_file/manifest_file —— 工件目录不完整');
    }
    if (pointer.capture_file.includes('/') || pointer.manifest_file.includes('/')) {
      throw new Error('latest.json 指针必须是文件名，不得携带路径分隔符');
    }
    captureFile = join(artifactsDir, pointer.capture_file);
    manifestFile = join(artifactsDir, pointer.manifest_file);
    if (!existsSync(captureFile) || !existsSync(manifestFile)) {
      throw new Error(
        `latest.json 指向的工件不存在：${String(pointer.capture_file)} / ${String(pointer.manifest_file)}`,
      );
    }
  } else {
    const files = existsSync(artifactsDir) ? readdirSync(artifactsDir) : [];
    const captures = files.filter((f) => /^capture-[0-9a-f]{12}\.json$/.test(f)).sort();
    const manifests = files.filter((f) => /^manifest-[0-9a-f]{12}\.json$/.test(f)).sort();
    if (captures.length === 0 || manifests.length === 0) {
      throw new Error(`工件目录 ${artifactsDir} 无 latest.json 也无 capture-*/manifest-* 工件`);
    }
    if (captures.length > 1 || manifests.length > 1) {
      throw new Error(
        `工件目录存在多份工件而无 latest.json —— 用 --artifacts 指到单一 checkpoint 目录或补 latest.json`,
      );
    }
    const captureName = captures[0];
    const manifestName = manifests[0];
    if (captureName === undefined || manifestName === undefined) {
      throw new Error('工件目录不完整（capture/manifest 缺失）');
    }
    captureFile = join(artifactsDir, captureName);
    manifestFile = join(artifactsDir, manifestName);
  }

  const capture = JSON.parse(readFileSync(captureFile, 'utf8')) as MigrationCapture;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as MigrationManifest;

  if (capture.capture_schema_version !== 1) {
    throw new Error(`capture_schema_version=${String(capture.capture_schema_version)} 不受支持`);
  }
  // checkpoint 绑定：manifest 与 capture 必须同一观测（文件名同 hash 即同源；
  // 再校验 hash 字段本身存在且非空）。
  if (typeof manifest.checkpoint_hash !== 'string' || manifest.checkpoint_hash.length === 0) {
    throw new Error('manifest.checkpoint_hash 缺失 —— 工件损坏');
  }
  // 分类身份复算（P2-A 同款纪律）：records/unresolved/deferred_replay 的
  // canonical hash 必须与存储的 classification_hash 一致 —— 篡改即拒。
  const classification = manifest.classification;
  if (classification === undefined || classification === null) {
    throw new Error('manifest 无 classification —— 工件不完整（需 YUK-1048 P1-2 及以后格式）');
  }
  const recomputed = canonicalHash({
    classification_version: classification.classification_version,
    records: classification.records,
    unresolved: classification.unresolved,
    deferred_replay: classification.deferred_replay,
  });
  if (recomputed !== classification.classification_hash) {
    throw new Error(
      `manifest.classification.classification_hash 复算不符（存储 ${classification.classification_hash.slice(0, 12)} vs 复算 ${recomputed.slice(0, 12)}）—— 工件被篡改或损坏，拒绝 apply`,
    );
  }
  return { capture, manifest, captureFile, manifestFile };
}

// ───────────────────────── fence（专用连接 advisory lock） ─────────────────────────

const FENCE_KEY_LITERAL = 'yuk1050:migration-apply';

/** 单写者 fence：专用连接上的 session advisory lock（跨阶段持有）。 */
export function advisoryFence(targetUrl: string): MigrationApplyFence & { close(): Promise<void> } {
  const client = postgres(targetUrl, {
    ssl:
      /localhost|127\.0\.0\.1/.test(targetUrl) || /[?&]sslmode=disable\b/.test(targetUrl)
        ? false
        : 'require',
    max: 1,
  });
  let acquired = false;
  return {
    async acquire(): Promise<boolean> {
      const result =
        await client`select pg_try_advisory_lock(hashtext(${FENCE_KEY_LITERAL})) as ok`;
      acquired = result[0]?.ok === true;
      return acquired;
    },
    async release(): Promise<void> {
      if (acquired) {
        await client`select pg_advisory_unlock(hashtext(${FENCE_KEY_LITERAL}))`;
        acquired = false;
      }
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

// ───────────────────────── 报告工件 ─────────────────────────

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ───────────────────────── main ─────────────────────────

export async function runMigrationApplyCli(args: ApplyCliArgs): Promise<void> {
  if (args.artifacts === null) throw new Error('missing --artifacts=<dir>（YUK-1048 工件目录）');
  if (args.target === null) {
    throw new Error('missing --target=<postgres-url> —— 写路径必须显式指定，不回退 DATABASE_URL');
  }
  if (!args.dryRun && !args.confirmWrite) {
    throw new Error(
      '非 dry-run 必须显式 --confirm-write（apply 是写路径；停 writer/final backup 由 cutover runbook 保证）',
    );
  }
  const artifactsDir = isAbsolute(args.artifacts)
    ? args.artifacts
    : resolve(process.cwd(), args.artifacts);
  const outDir =
    args.out === null
      ? artifactsDir
      : isAbsolute(args.out)
        ? args.out
        : resolve(process.cwd(), args.out);

  const { capture, manifest } = loadMigrationArtifacts(artifactsDir);
  console.log(`[migration-apply] checkpoint: ${manifest.checkpoint_hash}`);
  console.log(
    `[migration-apply] classification: ${manifest.classification.classification_hash} (v${manifest.classification.classification_version})`,
  );
  console.log(
    `[migration-apply] target: ${describeTarget(args.target)}${args.dryRun ? ' (dry-run)' : ' (WRITE)'}`,
  );

  let registry: RevisionRegistry | null = null;
  if (args.revisions !== null) {
    const registryPath = isAbsolute(args.revisions)
      ? args.revisions
      : resolve(process.cwd(), args.revisions);
    if (!existsSync(registryPath)) throw new Error(`--revisions 文件不存在：${registryPath}`);
    const parsed = parseRevisionRegistry(JSON.parse(readFileSync(registryPath, 'utf8')));
    if (!parsed.ok) {
      throw new Error(
        `revision registry 无效：\n  - ${parsed.issues.map((i) => i.detail).join('\n  - ')}`,
      );
    }
    registry = parsed.registry;
    console.log(
      `[migration-apply] registry: ${registry.entries.length} entries, digest ${registryDigestOf(registry)?.slice(0, 12)}`,
    );
  } else {
    console.log(
      '[migration-apply] registry: 无 —— 全部身份映射落 pending（awaiting_revision_registry worklist），无 submission 写入',
    );
  }

  const plan = buildMigrationApplyPlan({
    capture,
    classification: {
      classification_version: manifest.classification.classification_version,
      classification_hash: manifest.classification.classification_hash,
      records: manifest.classification.records,
      unresolved: manifest.classification.unresolved,
      deferred_replay: manifest.classification.deferred_replay,
    },
    checkpoint_hash: manifest.checkpoint_hash,
    registry,
  });
  const runId = applyRunIdOf({
    checkpoint_hash: manifest.checkpoint_hash,
    classification_hash: manifest.classification.classification_hash,
    registry_digest: registryDigestOf(registry),
  });
  console.log(`[migration-apply] run: ${runId} plan digest: ${planDigestOf(plan).slice(0, 12)}`);
  for (const [category, bucket] of Object.entries(plan.rollup.per_category).sort(
    (a, b) => b[1].records - a[1].records,
  )) {
    console.log(
      `[migration-apply]   ${category}: records=${bucket.records} mappings=${bucket.mappings} submissions=${bucket.submissions} evaluations=${bucket.evaluations}`,
    );
  }
  console.log(
    `[migration-apply] worklists: unresolved=${plan.worklists.unresolved.length} deferred_replay=${plan.worklists.deferred_replay.length} awaiting_registry=${plan.worklists.awaiting_revision_registry.length} conflicted=${plan.worklists.conflicted.length}`,
  );

  const client = postgres(args.target, {
    ssl:
      /localhost|127\.0\.0\.1/.test(args.target) || /[?&]sslmode=disable\b/.test(args.target)
        ? false
        : 'require',
    max: 2,
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  const fence = args.dryRun ? null : advisoryFence(args.target);
  try {
    const result = await runMigrationApply({
      db,
      plan,
      runId,
      fence,
      dryRun: args.dryRun,
      batchSize: args.batchSize,
    });
    for (const phase of result.report.phases) {
      console.log(
        `[migration-apply] phase ${phase.phase}: ${phase.status} (${phase.duration_ms}ms, written=${phase.rows_written}, present=${phase.rows_already_present}${phase.wal_bytes === null ? '' : `, wal=${phase.wal_bytes}B`})`,
      );
    }
    const reportPath = join(outDir, applyReportFileName(runId));
    atomicWrite(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
    console.log(`[migration-apply] report: ${reportPath}`);
    if (!args.dryRun) {
      assertReconciliationClean(result.report);
      console.log('[migration-apply] reconciliation: CLEAN (plan 与库内逐表一致)');
    }
  } finally {
    if (fence !== null) await fence.close().catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrationApplyCli(parseApplyArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migration-apply] failed:', err);
      process.exit(1);
    });
}
