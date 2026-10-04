// YUK-1059 — 集成发布 manifest / integration evidence CLI（grounding §15 末项）。
//
//   pnpm release:manifest [--target=<postgres-url>] [--out=<file>] [--no-git]
//
// 产出一份 assessment-release-manifest JSON：
//   lanes       — 本系列（1040-1059 + 1091-1100）merged 的 git log 行
//                 （contract / corrective / context / meta 分桶）；
//   migrations  — 本系列新增 drizzle/*.sql 及引入 commit；目标库可达时与
//                 drizzle.__drizzle_migrations 对账；
//   assertions  — post-release 断言表：只新写口活跃（epoch=active）、无
//                 runtime fallback 猜旧路径、pending 翻译/订阅零遗留、
//                 migration zero drift。
//
// 纪律（与 contract-epoch.ts 同款）：--target 必须是可解析 postgres URL，
// 绝不回退 DATABASE_URL；无 --target 时仍采集检出源码，DB 断言 info/skip。
// 库不可达时保留独立源码证据；源码不证明目标库对应的部署镜像。
// exit code：任何实际 fail（包括离线旧执行路径）→ 1；否则 0；CLI 错误 → 2。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  type AssertionContext,
  type AssessmentReleaseManifest,
  type LaneRow,
  type MigrationRow,
  buildAssertions,
  buildAssessmentManifest,
  collectAssertionContext,
  isSeriesMigration,
  parseLaneLog,
} from '@/server/release/assessment-manifest';
import { collectAssessmentSourceEvidence } from './lib/assessment-entrypoint-source';

const USAGE = `usage:
  release-manifest [--target=<postgres-url>] [--out=<file>] [--no-git]`;

// ───────────────────────────── git 侧采集（只读） ─────────────────────────────

function sh(cmd: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return { ok: false, err: String(r.error) };
  if (r.status !== 0) return { ok: false, err: (r.stderr ?? '').trim() };
  return { ok: true, out: r.stdout ?? '' };
}

/**
 * lanes：全历史 subject 扫描（本系列 commit 全部是带票号的 squash merge；
 * 过滤逻辑在 parseLaneCommit 内，不靠 regex 预筛丢掉边界行）。
 */
export function collectLanes(): { lanes: LaneRow[]; seriesBase: string | null } {
  const log = sh('git', ['log', '--format=%H%x09%s']);
  if (!log.ok) throw new Error(`git log failed: ${log.err}`);
  const lanes = parseLaneLog(log.out);
  if (lanes.length === 0) return { lanes, seriesBase: null };
  const oldest = lanes[lanes.length - 1];
  const parent = sh('git', ['rev-parse', `${oldest.sha}^`]);
  return {
    lanes,
    seriesBase: parent.ok ? parent.out.trim() : null,
  };
}

/**
 * migrations：drizzle/*.sql 全量 + 每文件的引入 commit（--diff-filter=A 首个
 * 触碰者）与 ticket 归属；series 判定用 isSeriesMigration（tag 或 commit）。
 */
export function collectMigrations(): {
  rows: MigrationRow[];
  seriesFiles: string[];
} {
  const files = readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const rows: MigrationRow[] = [];
  const seriesFiles: string[] = [];
  for (const file of files) {
    const rel = `drizzle/${file}`;
    const intro = sh('git', ['log', '--diff-filter=A', '--format=%H%x09%s', '-1', '--', rel]);
    const line = intro.ok ? (intro.out.split('\n')[0] ?? '') : '';
    const t = line.indexOf('\t');
    const addedSha = t === -1 ? '' : line.slice(0, t);
    const addedSubject = t === -1 ? null : line.slice(t + 1);
    const { series, ticket } = isSeriesMigration(file, addedSubject);
    rows.push({
      file: rel,
      addedBy: addedSha.length >= 7 ? addedSha.slice(0, 9) : addedSha,
      ticket,
    });
    if (series) seriesFiles.push(rel);
  }
  return { rows, seriesFiles };
}

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv: string[]): {
  target: string | null;
  out: string;
  noGit: boolean;
} {
  let target: string | null = null;
  let out: string | null = null;
  let noGit = false;
  for (const arg of argv) {
    if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg === '--no-git') noGit = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  // 默认落到 gitignored .remember/release/ —— manifest 含库计数但无 learner
  // 原始内容；显式 --out 优先（runbook 让 owner 指到 cutover 工件目录）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    target,
    out: out ?? resolve('.remember', 'release', `assessment-manifest-${stamp}.json`),
    noGit,
  };
}

/** contract-epoch.ts 同款 gate：非空可解析 postgres URL，host+db 齐备。 */
function requireTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--target is not a parseable URL: ${JSON.stringify(raw)}`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || url.pathname === '/') {
    throw new Error(
      `--target must be a postgres URL with host and database: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function printSummary(m: AssessmentReleaseManifest, out: string, seriesCount: number): void {
  const buckets = new Map<string, number>();
  for (const l of m.lanes) buckets.set(l.bucket, (buckets.get(l.bucket) ?? 0) + 1);
  console.log(`[release-manifest] out: ${out}`);
  console.log(
    `[release-manifest] lanes=${m.lanes.length} ` +
      [...buckets.entries()].map(([k, v]) => `${k}=${v}`).join(' '),
  );
  console.log(`[release-manifest] migrations: total=${m.migrations.length} series=${seriesCount}`);
  for (const a of m.assertions) {
    console.log(`[release-manifest] ${a.status.toUpperCase().padEnd(4)} ${a.id}: ${a.detail}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const notes: string[] = [];
  const evaluationSource = collectAssessmentSourceEvidence(process.cwd());

  const { lanes, seriesBase } = args.noGit
    ? { lanes: [] as LaneRow[], seriesBase: null }
    : collectLanes();
  const { rows: migrations, seriesFiles } = collectMigrations();
  if (args.noGit) notes.push('--no-git：lanes/series_base 未采集（预演模式）');
  if (seriesBase === null && !args.noGit) {
    notes.push('series_base 未解析（找不到首个带票 commit 的 parent）');
  }

  let assertions: ReturnType<typeof buildAssertions>;
  if (args.target === null) {
    assertions = buildAssertions(
      {
        outstanding: [],
        epoch: null,
        migrationsApplied: null,
        migrationFilesTotal: migrations.length,
        seriesMigrationFiles: seriesFiles,
        staleSubscriptionDeliveries: null,
        pendingEvaluations: null,
        expectedEpoch: 'assessment-contract-v1',
      },
      evaluationSource,
    );
    notes.push('无 --target：DB 断言未评估；检出源码 census 已独立采集。');
  } else {
    const target = requireTarget(args.target);
    const client = postgres(target, { max: 1, connect_timeout: 10, prepare: false });
    try {
      const ctx: AssertionContext = await collectAssertionContext(
        drizzle(client, { schema }) as unknown as Db,
        { migrationFilesTotal: migrations.length, seriesMigrationFiles: seriesFiles },
      );
      assertions = buildAssertions(ctx, evaluationSource);
    } catch (err) {
      // 库不可达：DB 断言未评估；独立的源码 census 仍保留。
      notes.push(
        `--target 连接失败（${err instanceof Error ? err.message : String(err)}）——DB 断言未评估`,
      );
      assertions = buildAssertions(
        {
          outstanding: [],
          epoch: null,
          migrationsApplied: null,
          migrationFilesTotal: migrations.length,
          seriesMigrationFiles: seriesFiles,
          staleSubscriptionDeliveries: null,
          pendingEvaluations: null,
          expectedEpoch: 'assessment-contract-v1',
        },
        evaluationSource,
      );
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  const manifest = buildAssessmentManifest({
    lanes,
    migrations,
    seriesBase: seriesBase ?? '',
    assertions,
    evaluationSource,
  });
  manifest.notes.push(...notes);

  const outPath = isAbsolute(args.out) ? args.out : resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  printSummary(manifest, outPath, seriesFiles.length);

  // Source failures remain failures even without a reachable database.
  if (assertions.some((a) => a.status === 'fail')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[release-manifest] failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
