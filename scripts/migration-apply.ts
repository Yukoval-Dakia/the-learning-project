// YUK-1050 — 历史迁移 apply CLI（grounding §13、§15；review P1-2/P1-8 修订）。
//
// 一次性离线 cutover 工具：消费 YUK-1048 捕获/分类工件（内容寻址目录 +
// latest.json 指针）与语料导入 lane 的 revision registry v2，按分类输出把历史
// 记录幂等写入 YUK-1044 真相源表。无 LLM、无学习重放；本工具本身就是
// cutover runbook 的迁移步骤，运行前提（停 writer、final backup）由 runbook
// 保证，不由本工具猜测。
//
// CLI（owner 于 cutover 窗口运行；只应指向隔离演练库或授权维护窗口的库）：
//   pnpm migration:apply --artifacts=<dir> --target=<postgres-url> --revisions=<registry.json> --confirm-write
//   pnpm migration:apply --artifacts=<dir> --target=<postgres-url> --revisions=<registry.json> --dry-run
//   可选：--out=<report-dir>（默认 = artifacts 目录）、--batch-size=<N>
//
// 安全纪律（P1-8）：--target 必须是【非空、可解析、host/database 齐备】的
// postgres URL —— 空串/残缺 URL 会让 postgres 驱动静默回退 env 默认，一律
// 在任何连接建立前拒绝。写路径必须显式 --target + --confirm-write，不回退
// DATABASE_URL。
//
// 工件纪律（P1-2）：装载即复算全部内容身份 —— checkpoint/raw-fact/edge/classification
// 四个哈希逐一与存储值比对（capture 与 manifest 必须是同一次观测）；分类
// 记录的 source 引用必须在 capture 内闭合；脱敏工件（无法忠实重建学习者
// 作答/证据）拒绝 apply。

import './load-env';

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  type RevisionRegistry,
  applyRunIdOf,
  buildMigrationApplyPlan,
  parseRevisionRegistry,
  planDigestOf,
  registryDigestOf,
  validateEntryCoordinates,
} from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
import { checkpointHashOf } from '@/core/migration/checkpoint';
import { buildCaptureEdges } from '@/core/migration/manifest';
import type { MigrationCapture, MigrationManifest } from '@/core/migration/types';
import { PublishedQuestionRevision } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { question_revision } from '@/db/schema';
import {
  type MigrationApplyFence,
  applyReportFileName,
  runMigrationApply,
} from '@/server/migration/apply';
import { describeTarget } from './migration-capture';

export const APPLY_TOOL_VERSION = '1.1.0';

// ───────────────────────── CLI 参数与 target 校验（P1-8） ─────────────────────────

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

export class ApplyCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyCliError';
  }
}

/**
 * target 校验（P1-8）：非空、postgres 协议、host 与 database 齐备。
 * `--target=`（空串）会让 postgres 驱动静默回退 env/默认 —— 在这里显式拒绝。
 */
export function validateTargetUrl(target: string | null): string {
  if (target === null || target.trim().length === 0) {
    throw new ApplyCliError(
      '--target 缺失或为空 —— 写路径必须显式指定完整 postgres URL，不回退 DATABASE_URL/驱动默认',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ApplyCliError(`--target 无法解析为 URL：'${target.slice(0, 60)}'`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ApplyCliError(`--target 协议必须为 postgres:/postgresql:（得到 ${parsed.protocol}）`);
  }
  if (parsed.hostname.length === 0) {
    throw new ApplyCliError('--target 缺 host —— 残缺 URL 会让驱动静默回退 env 默认，拒绝');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (database.length === 0) {
    throw new ApplyCliError(
      '--target 缺 database 名（pathname 为空）—— 拒绝在驱动默认库上执行迁移',
    );
  }
  return target;
}

// ───────────────────────── 工件加载与身份复算（P1-2） ─────────────────────────

export interface LoadedArtifacts {
  capture: MigrationCapture;
  manifest: MigrationManifest;
  captureFile: string;
  manifestFile: string;
}

/**
 * 加载 YUK-1048 工件并复算【全部内容身份】：
 *   (a) latest 指针的 checkpoint_hash 与 manifest 一致；
 *   (b) checkpoint 身份：checkpointHashOf(capture, provenance) 重算比对
 *       （证明 capture 就是 manifest 的那次观测 —— 换 capture/换 manifest 拼装
 *       在此被拒）；
 *   (c) raw-fact canonical hash 与 edge hash 重算比对；
 *   (d) classification hash 按存储 version 复算（篡改即拒）；
 *   (e) 分类记录的 source 引用在 capture 内闭合；
 *   (f) 脱敏工件拒绝（占位符无法忠实重建学习者作答/证据）。
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
      throw new ApplyCliError('latest.json 指针缺 capture_file/manifest_file —— 工件目录不完整');
    }
    if (pointer.capture_file.includes('/') || pointer.manifest_file.includes('/')) {
      throw new ApplyCliError('latest.json 指针必须是文件名，不得携带路径分隔符');
    }
    captureFile = join(artifactsDir, pointer.capture_file);
    manifestFile = join(artifactsDir, pointer.manifest_file);
    if (!existsSync(captureFile) || !existsSync(manifestFile)) {
      throw new ApplyCliError(
        `latest.json 指向的工件不存在：${String(pointer.capture_file)} / ${String(pointer.manifest_file)}`,
      );
    }
    if (typeof pointer.checkpoint_hash !== 'string' || pointer.checkpoint_hash.length === 0) {
      throw new ApplyCliError('latest.json 缺 checkpoint_hash —— 指针不完整');
    }
  } else {
    const files = existsSync(artifactsDir) ? readdirSync(artifactsDir) : [];
    const captures = files.filter((f) => /^capture-[0-9a-f]{12}\.json$/.test(f)).sort();
    const manifests = files.filter((f) => /^manifest-[0-9a-f]{12}\.json$/.test(f)).sort();
    if (captures.length === 0 || manifests.length === 0) {
      throw new ApplyCliError(
        `工件目录 ${artifactsDir} 无 latest.json 也无 capture-*/manifest-* 工件`,
      );
    }
    if (captures.length > 1 || manifests.length > 1) {
      throw new ApplyCliError(
        `工件目录存在多份工件而无 latest.json —— 用 --artifacts 指到单一 checkpoint 目录或补 latest.json`,
      );
    }
    const captureName = captures[0];
    const manifestName = manifests[0];
    if (captureName === undefined || manifestName === undefined) {
      throw new ApplyCliError('工件目录不完整（capture/manifest 缺失）');
    }
    captureFile = join(artifactsDir, captureName);
    manifestFile = join(artifactsDir, manifestName);
  }

  const capture = JSON.parse(readFileSync(captureFile, 'utf8')) as MigrationCapture;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as MigrationManifest;

  if (capture.capture_schema_version !== 1) {
    throw new ApplyCliError(
      `capture_schema_version=${String(capture.capture_schema_version)} 不受支持`,
    );
  }
  if (typeof manifest.checkpoint_hash !== 'string' || manifest.checkpoint_hash.length === 0) {
    throw new ApplyCliError('manifest.checkpoint_hash 缺失 —— 工件损坏');
  }
  // (f) 脱敏工件不能支撑忠实重建（作答/证据是占位哈希）—— 拒绝。
  if (manifest.redaction?.applied === true) {
    throw new ApplyCliError(
      '工件为脱敏形态（redaction.applied）—— 占位内容无法忠实重建学习者作答/证据，拒绝 apply',
    );
  }

  // (a) 指针与 manifest 的 checkpoint 一致。
  if (existsSync(latestPath)) {
    const pointer = JSON.parse(readFileSync(latestPath, 'utf8')) as { checkpoint_hash?: unknown };
    if (pointer.checkpoint_hash !== manifest.checkpoint_hash) {
      throw new ApplyCliError(
        `latest.json 指针 checkpoint 与 manifest 不符（${String(pointer.checkpoint_hash).slice(0, 12)} vs ${manifest.checkpoint_hash.slice(0, 12)}）—— 工件目录混装`,
      );
    }
  }

  // (b) checkpoint 身份：capture + manifest 携带的 provenance 重算。
  const provenance = {
    tool_version: manifest.tool.version,
    git_sha: manifest.source.git_sha,
    app_image: manifest.source.app_image,
    worker_image: manifest.source.worker_image,
    migration_files: manifest.source.db.migration_files,
    redaction: manifest.redaction,
  };
  const recomputedCheckpoint = checkpointHashOf(capture, provenance);
  if (recomputedCheckpoint !== manifest.checkpoint_hash) {
    throw new ApplyCliError(
      `checkpoint 身份复算不符（存储 ${manifest.checkpoint_hash.slice(0, 12)} vs 复算 ${recomputedCheckpoint.slice(0, 12)}）—— capture 与 manifest 不是同一次观测，拒绝 apply`,
    );
  }
  // (c) raw-fact 与 edge 身份重算。
  const recomputedRawFacts = canonicalHash(capture.rawFacts);
  if (recomputedRawFacts !== manifest.raw_fact_hash?.canonical) {
    throw new ApplyCliError(
      `raw-fact hash 复算不符（存储 ${String(manifest.raw_fact_hash?.canonical).slice(0, 12)} vs 复算 ${recomputedRawFacts.slice(0, 12)}）—— capture 内容与 manifest 观测不符`,
    );
  }
  const recomputedEdges = canonicalHash(buildCaptureEdges(capture));
  if (recomputedEdges !== manifest.edge_hash?.digest) {
    throw new ApplyCliError(
      `edge hash 复算不符（存储 ${String(manifest.edge_hash?.digest).slice(0, 12)} vs 复算 ${recomputedEdges.slice(0, 12)}）—— 引用闭包与 manifest 观测不符`,
    );
  }

  // (d) 分类身份复算（按存储 version，对齐 YUK-1048 P2-A）。
  const classification = manifest.classification;
  if (classification === undefined || classification === null) {
    throw new ApplyCliError(
      'manifest 无 classification —— 工件不完整（需 YUK-1048 P1-2 及以后格式）',
    );
  }
  const recomputedClassification = canonicalHash({
    classification_version: classification.classification_version,
    records: classification.records,
    unresolved: classification.unresolved,
    deferred_replay: classification.deferred_replay,
  });
  if (recomputedClassification !== classification.classification_hash) {
    throw new ApplyCliError(
      `manifest.classification.classification_hash 复算不符（存储 ${String(classification.classification_hash).slice(0, 12)} vs 复算 ${recomputedClassification.slice(0, 12)}）—— 工件被篡改或损坏，拒绝 apply`,
    );
  }

  // (e) 分类记录的 source 引用必须在 capture 内闭合（记录 ↔ 观测同源）。
  const eventIds = new Set(capture.rawFacts.events.map((e) => e.id));
  const answerIds = new Set(capture.rawFacts.answers.map((a) => a.id));
  const dangling: string[] = [];
  for (const record of classification.records) {
    const known =
      record.source_kind === 'event'
        ? eventIds.has(record.source_id)
        : answerIds.has(record.source_id);
    if (!known) dangling.push(record.source_locator);
    if (dangling.length >= 5) break;
  }
  if (dangling.length > 0) {
    throw new ApplyCliError(
      `分类记录引用了 capture 中不存在的 source（${dangling.join(', ')}${dangling.length >= 5 ? ' …' : ''}）—— classification 与 capture 不同源，拒绝 apply`,
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

// ───────────────────────── revision contracts 装载 ─────────────────────────

/**
 * 从目标库装载 registry 引用的 question_revision 行并解析为五层契约
 * （PublishedQuestionRevision）。行缺失在 executor preflight 再拒；这里
 * 聚焦「行在但内容不契约」的 fail-visible。
 */
export async function loadRevisionContracts(
  db: Db,
  registry: RevisionRegistry | null,
): Promise<Map<string, import('@/core/schema/assessment').PublishedQuestionRevisionT>> {
  const contracts = new Map<
    string,
    import('@/core/schema/assessment').PublishedQuestionRevisionT
  >();
  if (registry === null || registry.entries.length === 0) return contracts;
  const revisionIds = [...new Set(registry.entries.map((e) => e.revision_id))];
  const rows = await db
    .select()
    .from(question_revision)
    .where(inArray(question_revision.revision_id, revisionIds));
  const foundRevisions = new Set(rows.map((r) => r.revision_id));
  const missingRevisions = revisionIds.filter((id) => !foundRevisions.has(id));
  if (missingRevisions.length > 0) {
    throw new ApplyCliError(
      `registry 指向的 revision 在目标库不存在（语料导入未跑或 registry 过期）：${missingRevisions.slice(0, 5).join(', ')}${missingRevisions.length > 5 ? ` …共 ${missingRevisions.length} 个` : ''}`,
    );
  }
  const issues: string[] = [];
  for (const row of rows) {
    const parsed = PublishedQuestionRevision.safeParse({
      revision_id: row.revision_id,
      group_id: row.group_id,
      revision_ordinal: row.revision_ordinal,
      integrity_digest: row.integrity_digest,
      structure: row.structure,
      response_spec: row.response_spec,
      scoring_basis: row.scoring_basis,
      execution_plan: row.execution_plan,
      published_at: row.published_at.toISOString(),
      supersedes_revision_id: row.supersedes_revision_id,
    });
    if (parsed.success) {
      contracts.set(row.revision_id, parsed.data);
    } else {
      issues.push(
        `${row.revision_id}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}`)
          .slice(0, 4)
          .join(',')}`,
      );
    }
  }
  if (issues.length > 0) {
    throw new ApplyCliError(
      `question_revision 行不符合五层契约（语料导入产物损坏）：\n  - ${issues.join('\n  - ')}`,
    );
  }
  // P1-2（终轮）：每一条 registry 绑定（不限 submission 锚）都对契约做普适坐标
  // 校验 —— part/slot/unit 关联在装载即 fail-visible，坏条目在写库前被拒。
  const coordinateIssues: string[] = [];
  for (const entry of registry.entries) {
    const contract = contracts.get(entry.revision_id);
    if (contract === undefined) continue; // 缺失行已在上方整体拒绝
    for (const issue of validateEntryCoordinates(entry, contract)) {
      coordinateIssues.push(`${entry.question_id} → ${entry.revision_id}: ${issue.detail}`);
    }
  }
  if (coordinateIssues.length > 0) {
    throw new ApplyCliError(
      `registry 绑定坐标未过 revision 契约校验：\n  - ${coordinateIssues.join('\n  - ')}`,
    );
  }
  return contracts;
}

// ───────────────────────── 报告工件 ─────────────────────────

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ───────────────────────── main ─────────────────────────

export async function runMigrationApplyCli(args: ApplyCliArgs): Promise<void> {
  if (args.artifacts === null)
    throw new ApplyCliError('missing --artifacts=<dir>（YUK-1048 工件目录）');
  const target = validateTargetUrl(args.target);
  if (!args.dryRun && !args.confirmWrite) {
    throw new ApplyCliError(
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
  console.log(
    `[migration-apply] checkpoint: ${manifest.checkpoint_hash}（checkpoint/raw-fact/edge/classification 身份已复算一致）`,
  );
  console.log(
    `[migration-apply] classification: ${manifest.classification.classification_hash} (v${manifest.classification.classification_version})`,
  );
  console.log(
    `[migration-apply] target: ${describeTarget(target)}${args.dryRun ? ' (dry-run)' : ' (WRITE)'}`,
  );

  let registry: RevisionRegistry | null = null;
  if (args.revisions !== null) {
    const registryPath = isAbsolute(args.revisions)
      ? args.revisions
      : resolve(process.cwd(), args.revisions);
    if (!existsSync(registryPath))
      throw new ApplyCliError(`--revisions 文件不存在：${registryPath}`);
    const parsed = parseRevisionRegistry(JSON.parse(readFileSync(registryPath, 'utf8')));
    if (!parsed.ok) {
      throw new ApplyCliError(
        `revision registry 无效：\n  - ${parsed.issues.map((i) => i.detail).join('\n  - ')}`,
      );
    }
    registry = parsed.registry;
    console.log(
      `[migration-apply] registry: ${registry.entries.length} entries, digest ${registryDigestOf(registry)?.slice(0, 12)}`,
    );
  } else {
    console.log(
      '[migration-apply] registry: 无 —— 全部身份映射落 pending（awaiting_revision_registry worklist）；registry 后到时同 checkpoint 重跑走显式 pending→resolved 接替',
    );
  }

  const client = postgres(target, {
    ssl:
      /localhost|127\.0\.0\.1/.test(target) || /[?&]sslmode=disable\b/.test(target)
        ? false
        : 'require',
    max: 2,
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  const fence = args.dryRun ? null : advisoryFence(target);
  try {
    const revisionContracts = await loadRevisionContracts(db, registry);
    console.log(`[migration-apply] revision contracts: ${revisionContracts.size} loaded`);

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
      revisionContracts,
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
    const work = plan.worklists;
    console.log(
      `[migration-apply] worklists: unresolved=${work.unresolved.length} deferred_replay=${work.deferred_replay.length} awaiting_registry=${work.awaiting_revision_registry.length} conflicted=${work.conflicted.length} live_drafts=${work.live_drafts.length} reconstruction_blocked=${work.reconstruction_blocked.length}`,
    );

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
    // P2：worklist【明细】随报告工件落盘（控制台只打计数，工件可审计）。
    const reportPath = join(outDir, applyReportFileName(runId));
    atomicWrite(
      reportPath,
      `${JSON.stringify(
        {
          ...result.report,
          worklists_detail: plan.worklists,
          plan_per_category: plan.rollup.per_category,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`[migration-apply] report: ${reportPath}`);
    const headActivations = result.report.reconciliation.heads_current.filter(
      (h) => h.post_migration_activation,
    );
    if (headActivations.length > 0) {
      console.log(
        `[migration-apply] note: ${headActivations.length} head(s) 已被迁移后激活/推进（generation>0，合法演进，见报告 heads_current）`,
      );
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
