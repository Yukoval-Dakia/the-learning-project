// YUK-1048 — 迁移捕获 CLI（grounding §13–§14）。
//
// 一次性离线工具：对显式 DB target 运行 REPEATABLE READ READ ONLY 的精确观测
// 捕获（FSRS/mastery 全分区、family/item calibration labels、axis、signals、
// 结构血缘 + 原始 eventID/body/time/actor/cost/causal 链），native 分类，
// 产出 §14 manifest。不是重算，不是 replay 证明，绝不写目标库。
//
// CLI（owner 运行；产物含真实内容，默认不 commit 进仓库）：
//   pnpm migration:capture --out=<dir> --target=<postgres-url>
//   pnpm migration:capture --out=<dir>                     # 用 DATABASE_URL
//   pnpm migration:capture --out=<dir> --redact            # 脱敏 learner 文本
//   可选：--app-image=<tag> --worker-image=<tag> --git-sha=<sha>
//
// 幂等：工件按 raw-fact canonical hash 内容寻址
// （capture-<hash12>.json / manifest-<hash12>.json + latest.json 指针）。
// 同一 DB 状态重跑 → 同 hash → 同文件名 → 已存在即跳过（不产生重复捕获）；
// 状态变化 → 新 hash → 新工件追加，旧观测永不覆盖删除。

// Load `.env` BEFORE anything that reads env at import time. db 客户端是
// main() 内惰性构建（本模块顶层保持纯净 —— unit test 无需 DATABASE_URL）。
import './load-env';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { shortHash, stableStringify } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { buildMigrationManifest } from '@/core/migration/manifest';
import { redactMigrationCapture, redactedFieldList } from '@/core/migration/redact';
import type { MigrationCapture, MigrationManifest } from '@/core/migration/types';
import * as schema from '@/db/schema';
import { captureMigrationCheckpoint } from '@/server/migration/capture';

export const TOOL_VERSION = '1.0.0';

// ───────────────────────────── CLI 参数 ─────────────────────────────

export interface CaptureCliArgs {
  out: string | null;
  target: string | null;
  redact: boolean;
  appImage: string | null;
  workerImage: string | null;
  gitSha: string | null;
}

export function parseCaptureArgs(argv: string[]): CaptureCliArgs {
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
    out: readFlag('out'),
    target: readFlag('target'),
    redact: argv.includes('--redact'),
    appImage: readFlag('app-image'),
    workerImage: readFlag('worker-image'),
    gitSha: readFlag('git-sha'),
  };
}

/** 打印/记录用的 target 描述：host+db，绝不含凭证。 */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable-url)';
  }
}

function buildDb(targetUrl: string) {
  const isLocal = /localhost|127\.0\.0\.1/.test(targetUrl);
  const hasSslDisable = /[?&]sslmode=disable\b/.test(targetUrl);
  const client = postgres(targetUrl, {
    ssl: isLocal || hasSslDisable ? false : 'require',
    max: 2,
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

// ───────────────────────── 幂等工件写入（内容寻址） ─────────────────────────

export interface ArtifactWriteResult {
  outDir: string;
  rawFactHash: string;
  captureFile: string;
  manifestFile: string;
  captureStatus: 'written' | 'already-present';
  manifestStatus: 'written' | 'already-present';
  latestStatus: 'written' | 'unchanged';
}

/**
 * 内容寻址写入：文件名派生自 raw-fact canonical hash（与运行时刻无关）。
 * 已存在的同 hash 工件不重写（首见观测胜出 —— 快照时刻以首个 manifest 为准）；
 * 不同 hash 的新工件并存，latest.json 指针前移。绝不删除旧工件。
 */
export function writeCaptureArtifacts(
  outDir: string,
  capture: MigrationCapture,
  manifest: MigrationManifest,
): ArtifactWriteResult {
  mkdirSync(outDir, { recursive: true });
  const hash12 = shortHash(manifest.raw_fact_hash.canonical);
  const captureFile = `capture-${hash12}.json`;
  const manifestFile = `manifest-${hash12}.json`;
  const capturePath = join(outDir, captureFile);
  const manifestPath = join(outDir, manifestFile);

  let captureStatus: ArtifactWriteResult['captureStatus'] = 'already-present';
  if (!existsSync(capturePath)) {
    writeFileSync(capturePath, `${stableStringify(capture)}\n`);
    captureStatus = 'written';
  }
  let manifestStatus: ArtifactWriteResult['manifestStatus'] = 'already-present';
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${stableStringify(manifest)}\n`);
    manifestStatus = 'written';
  }

  const latestPath = join(outDir, 'latest.json');
  const pointer = {
    raw_fact_hash: manifest.raw_fact_hash.canonical,
    capture_file: captureFile,
    manifest_file: manifestFile,
    captured_at: manifest.source.captured_at,
  };
  let latestStatus: ArtifactWriteResult['latestStatus'] = 'written';
  if (existsSync(latestPath)) {
    try {
      const existing = JSON.parse(readFileSync(latestPath, 'utf8')) as { raw_fact_hash?: string };
      if (existing.raw_fact_hash === pointer.raw_fact_hash) {
        latestStatus = 'unchanged';
      }
    } catch {
      // 损坏的指针文件直接覆写（fail-visible 到 status）。
    }
  }
  if (latestStatus === 'written') {
    writeFileSync(latestPath, `${JSON.stringify(pointer, null, 2)}\n`);
  }

  return {
    outDir,
    rawFactHash: manifest.raw_fact_hash.canonical,
    captureFile,
    manifestFile,
    captureStatus,
    manifestStatus,
    latestStatus,
  };
}

// ───────────────────────────── 观测来源 ─────────────────────────────

function currentGitSha(): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function migrationFileCount(): number | null {
  const dir = resolve(fileURLToPath(new URL('..', import.meta.url)), 'drizzle');
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).length;
}

// ───────────────────────────── main ─────────────────────────────

export async function runMigrationCapture(args: CaptureCliArgs): Promise<ArtifactWriteResult> {
  if (args.out === null) {
    throw new Error('missing --out=<dir>');
  }
  const targetUrl = args.target ?? process.env.DATABASE_URL ?? null;
  if (targetUrl === null || targetUrl === '') {
    throw new Error('no explicit --target and no DATABASE_URL — refusing to guess a database');
  }
  const outDir = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);

  console.log(
    `[migration-capture] target: ${describeTarget(targetUrl)} (REPEATABLE READ READ ONLY)`,
  );
  const { db, close } = buildDb(targetUrl);
  try {
    let capture = await captureMigrationCheckpoint(db);
    if (args.redact) {
      capture = redactMigrationCapture(capture);
    }
    const classification = classifyMigrationCapture(capture);
    const manifest = buildMigrationManifest(capture, classification, {
      tool_version: TOOL_VERSION,
      git_sha: args.gitSha ?? currentGitSha(),
      app_image: args.appImage,
      worker_image: args.workerImage,
      migration_files: migrationFileCount(),
      redaction: { applied: args.redact, fields: args.redact ? redactedFieldList() : [] },
    });
    const result = writeCaptureArtifacts(outDir, capture, manifest);

    console.log(`[migration-capture] raw-fact hash: ${result.rawFactHash}`);
    console.log(
      `[migration-capture] artifacts: ${result.captureFile} (${result.captureStatus}), ` +
        `${result.manifestFile} (${result.manifestStatus}), latest.json (${result.latestStatus})`,
    );
    const rollup = Object.entries(classification.rollup).sort((a, b) => b[1] - a[1]);
    for (const [category, count] of rollup) {
      console.log(`[migration-capture]   ${category}: ${count}`);
    }
    console.log(
      `[migration-capture] unresolved: ${classification.unresolved.length}, ` +
        `deferred replay: ${classification.deferred_replay.length}`,
    );
    return result;
  } finally {
    await close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrationCapture(parseCaptureArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migration-capture] failed:', err);
      process.exit(1);
    });
}
