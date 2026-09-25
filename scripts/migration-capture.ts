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
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { shortHash, stableStringify } from '@/core/migration/canonical';
import { type CheckpointProvenance, checkpointHashOf } from '@/core/migration/checkpoint';
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

// ──────────────────── 幂等工件写入（checkpoint 内容寻址，review P1-1/P1-2/P2-B） ────────────────────

export interface ArtifactWriteResult {
  outDir: string;
  /** 整个观测 checkpoint 的内容身份（rawFacts+ops+queues+subscriptions+provenance；不含运行时钟）。 */
  checkpointHash: string;
  captureFile: string;
  manifestFile: string;
  captureStatus: 'written' | 'already-present' | 'repaired';
  manifestStatus: 'written' | 'already-present' | 'repaired' | 'refreshed';
  latestStatus: 'written' | 'unchanged';
}

/** 原子发布：写临时文件 + rename（同目录，原子替换；P2-B —— 并发写者不互踩半文件）。 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * checkpoint 内容寻址写入（P1-1）：文件名派生自 manifest.checkpoint_hash ——
 * 覆盖 rawFacts + ops（ingest_at 等）+ queues/subscription/ai_task_runs + provenance；
 * 唯独排除随运行变化的 snapshot_at/captured_at（重跑不产生重复捕获的前提）。
 * 运维态变化 ⇒ 新 checkpoint hash ⇒ 新工件；不会被旧文件名吞掉。
 *
 * 验证而非盲跳过（P1-1）：已存在的工件读回并复算身份 —— 损坏/身份不符 ⇒ 重写
 * （repaired）。manifest 额外按 classification_hash 刷新（P1-2：分类器改进 ⇒
 * 同 checkpoint 的 manifest 被重写为最新分类，capture 观测保持首见胜出）。
 * latest.json 在两个工件都落盘后最后发布。
 */
export function writeCaptureArtifacts(
  outDir: string,
  capture: MigrationCapture,
  manifest: MigrationManifest,
  provenance: CheckpointProvenance,
): ArtifactWriteResult {
  mkdirSync(outDir, { recursive: true });
  const hash12 = shortHash(manifest.checkpoint_hash);
  const captureFile = `capture-${hash12}.json`;
  const manifestFile = `manifest-${hash12}.json`;
  const capturePath = join(outDir, captureFile);
  const manifestPath = join(outDir, manifestFile);

  let captureStatus: ArtifactWriteResult['captureStatus'] = 'already-present';
  if (existsSync(capturePath)) {
    try {
      const stored = JSON.parse(readFileSync(capturePath, 'utf8')) as MigrationCapture;
      if (checkpointHashOf(stored, provenance) !== manifest.checkpoint_hash) {
        atomicWrite(capturePath, `${stableStringify(capture)}\n`);
        captureStatus = 'repaired';
      }
    } catch {
      atomicWrite(capturePath, `${stableStringify(capture)}\n`);
      captureStatus = 'repaired';
    }
  } else {
    atomicWrite(capturePath, `${stableStringify(capture)}\n`);
    captureStatus = 'written';
  }

  const expectedManifest = `${stableStringify(manifest)}\n`;
  let manifestStatus: ArtifactWriteResult['manifestStatus'] = 'already-present';
  if (existsSync(manifestPath)) {
    try {
      const stored = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
      const identityOk = stored.checkpoint_hash === manifest.checkpoint_hash;
      const classificationCurrent =
        stored.classification?.classification_hash === manifest.classification.classification_hash;
      if (!identityOk) {
        atomicWrite(manifestPath, expectedManifest);
        manifestStatus = 'repaired';
      } else if (!classificationCurrent) {
        // P1-2：分类器改进/分类版本变化 —— 同一观测的最新分类必须持久化。
        atomicWrite(manifestPath, expectedManifest);
        manifestStatus = 'refreshed';
      }
    } catch {
      atomicWrite(manifestPath, expectedManifest);
      manifestStatus = 'repaired';
    }
  } else {
    atomicWrite(manifestPath, expectedManifest);
    manifestStatus = 'written';
  }

  // latest 指针最后发布（两个工件已原子落盘）。
  const latestPath = join(outDir, 'latest.json');
  const pointer = {
    checkpoint_hash: manifest.checkpoint_hash,
    capture_file: captureFile,
    manifest_file: manifestFile,
    captured_at: manifest.source.captured_at,
  };
  let latestStatus: ArtifactWriteResult['latestStatus'] = 'written';
  if (existsSync(latestPath)) {
    try {
      const existing = JSON.parse(readFileSync(latestPath, 'utf8')) as { checkpoint_hash?: string };
      if (existing.checkpoint_hash === pointer.checkpoint_hash) {
        latestStatus = 'unchanged';
      }
    } catch {
      // 损坏的指针文件直接覆写（fail-visible 到 status）。
    }
  }
  if (latestStatus === 'written') {
    atomicWrite(latestPath, `${JSON.stringify(pointer, null, 2)}\n`);
  }

  return {
    outDir,
    checkpointHash: manifest.checkpoint_hash,
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
    const provenance: CheckpointProvenance = {
      tool_version: TOOL_VERSION,
      git_sha: args.gitSha ?? currentGitSha(),
      app_image: args.appImage,
      worker_image: args.workerImage,
      migration_files: migrationFileCount(),
      redaction: { applied: args.redact, fields: args.redact ? redactedFieldList() : [] },
    };
    const classification = classifyMigrationCapture(capture);
    const manifest = buildMigrationManifest(capture, classification, provenance);
    const result = writeCaptureArtifacts(outDir, capture, manifest, provenance);

    console.log(`[migration-capture] checkpoint hash: ${result.checkpointHash}`);
    console.log(`[migration-capture] raw-fact hash: ${manifest.raw_fact_hash.canonical}`);
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
