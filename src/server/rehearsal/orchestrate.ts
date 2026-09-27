// ====================================================================
// YUK-1057 — 隔离演练编排器（restore → migration → cutover → rollback 全链）
// ====================================================================
//
// 全流程（grounding §15–§16 对应；产物落 <out>/，步骤账本 steps.jsonl）：
//
//   01 provision      ephemeral pgvector/pg16 容器 + 完整启动面 migrate
//                     （drizzle 迁移 + builtin seed + trait reconcile +
//                     projection readiness + epoch marker —— scripts/migrate.ts）。
//   02 seed           合成语料（corpus.ts + contract-corpus.ts + 隔离 blob）。
//   03 backup         容器内 pg_dump -Fc（生产 dump 形态）→ dump 工件 + sha256。
//   04 restore-proof  同容器新库 rehearsal_restore → pg_restore →
//                     snapshotDbState 逐表比对（restore identity 证据）。
//                     【同时是 rollback 边界 (a)：新写入前 restore 的已验证形态】
//   05 capture        migration:capture（幂等重跑：第二遍 already-present）。
//   06 window-open    begin_prepare('assessment-contract-v1') + stale-writer
//                     锁注入（terminate 恢复）+ fence 探针（preparing 拒跑）。
//   07 migrate-apply  无 registry apply（中途 terminate backend 崩溃注入 →
//                     resume 收敛；失败处置）→ fence 占用时 apply 被拒（单写者
//                     纪律）→ 幂等重跑（全 phases skipped 零写入）→ registry 版
//                     重跑（pending→resolved supersession）。
//   08 mark-ready     mark_ready → 'ready' 下 fence 仍拒（安静窗口）。
//   09 activate       activate('assessment-contract-v1')；本二进制 code epoch
//                     = legacy → active 后探针给出 epoch_mismatch 拒跑 —— 正是
//                     演练证据：「旧代码在 post-cutover DB 上不得跑」。
//   10 post-writes    新写入（publish/issue/draft/submit；域 seam 不经 API
//                     middleware/ worker fence —— 与 CLI 直写一致）。
//   11 delta-export   exportPostWriteDelta（行级 canonical JSON + digest）。
//   12 rollback-b     独立库 rehearsal_rollback：restore 旧 dump →
//                     replayPostWriteDelta → reconcilePostWriteDelta
//                     （roll-forward + 导出对账 = 边界 (b)）。
//   13 report         steps.jsonl + report.json + cutover-window.json。
//
// 全部步骤在 ephemeral 容器内完成；绝不触碰 running compose。migration
// capture/apply 与 epoch transition 全部 in-process 调真实实现（不走
// stdout 解析）；apply 用 application_name 打标的连接，故障注入 =
// pg_terminate_backend(application_name='yuk1057-apply')，确定性杀在执行
// 中途（phase ledger 'running' 行出现后）。

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  applyRunIdOf,
  buildMigrationApplyPlan,
  parseRevisionRegistry,
  registryDigestOf,
} from '@/core/migration/apply';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { checkContractEpoch, transitionContractEpoch } from '@/server/contract-epoch';
import {
  type MigrationApplyFence,
  applyReportFileName,
  runMigrationApply,
} from '@/server/migration/apply';
import { isolatedBlobStore } from './blob-store';
import { buildRehearsalRegistry, seedContractCorpus } from './contract-corpus';
import { seedRehearsalCorpus } from './corpus';
import { CutoverClock, probeEpochFence, simulateStaleWriterLock } from './cutover';
import { diffDbStates, snapshotDbState, writeProof } from './db-proof';
import { REHEARSAL_PG_IMAGE, startEphemeralPg } from './ephemeral-pg';
import {
  type PostWriteDelta,
  type PostWriteHandle,
  exportPostWriteDelta,
  reconcilePostWriteDelta,
  replayPostWriteDelta,
  simulatePostCutoverWrites,
} from './post-write';

// 每个 in-process apply 的连接打标 —— 故障注入按 application_name terminate，
// 不碰编排器自己的连接。
const APPLY_APP_NAME = 'yuk1057-apply';

export interface RehearsalOptions {
  /** 工件根（调用方给绝对路径；通常 .remember/rehearsal/<ts>）。 */
  out: string;
}

export interface StepRecord {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  duration_ms: number;
  detail: Record<string, unknown>;
  error?: string;
}

export interface RehearsalReport {
  run_at: string;
  out_dir: string;
  steps: StepRecord[];
  acceptance: {
    restore_proof: boolean;
    migration_idempotent: boolean;
    fault_recovery: boolean;
    rollback_boundary_a: boolean;
    rollback_boundary_b: boolean;
    cutover_window_measured: boolean;
    failure_handling_recorded: boolean;
  };
  artifacts: Record<string, string>;
}

const STEP_LOG = 'steps.jsonl';

function makeLogger(out: string) {
  mkdirSync(out, { recursive: true });
  const logPath = join(out, STEP_LOG);
  return (step: StepRecord) => {
    appendFileSync(logPath, `${JSON.stringify(step)}\n`);
  };
}

async function stepRun(
  steps: StepRecord[],
  log: (s: StepRecord) => void,
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<StepRecord> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const rec: StepRecord = {
      name,
      status: 'ok',
      duration_ms: Date.now() - t0,
      detail,
    };
    steps.push(rec);
    log(rec);
    console.log(`[rehearsal] ${name}: ok (${rec.duration_ms}ms)`);
    return rec;
  } catch (err) {
    const rec: StepRecord = {
      name,
      status: 'failed',
      duration_ms: Date.now() - t0,
      detail: {},
      error: err instanceof Error ? err.message : String(err),
    };
    steps.push(rec);
    log(rec);
    console.error(`[rehearsal] ${name}: FAILED — ${rec.error}`);
    throw new Error(`rehearsal step '${name}' failed: ${rec.error}`);
  }
}

interface ApplyOnceResult {
  runId: string;
  reportPath: string;
  phases: Array<{
    phase: string;
    status: string;
    rows_written: number;
    rows_already_present: number;
  }>;
  reconciliation: {
    mapping_rows_superseded_in_run: number;
    divergences: string[];
  };
}

/**
 * 与 scripts/migration-apply.ts 同路径的 in-process apply（report JSON 同样
 * 落 artifactsDir）。application_name 打标使 pg_terminate_backend 故障注入
 * 精确命中 apply 的连接（fence 由 advisoryFence 另开连接，同样打标在 URL
 * 参数层无法注入 —— 故注入等待点取 phase ledger 'running'，此刻 fence
 * 连接与 worker 池都在，terminate 后锁随连接死亡释放）。
 */
async function applyOnce(args: {
  targetUrl: string;
  artifactsDir: string;
  registryPath: string | null;
  batchSize?: number;
}): Promise<ApplyOnceResult> {
  const { loadMigrationArtifacts, loadRevisionContracts, advisoryFence } = await import(
    '../../../scripts/migration-apply'
  );
  const { capture, manifest } = loadMigrationArtifacts(args.artifactsDir);

  let registry = null;
  if (args.registryPath !== null) {
    const parsed = parseRevisionRegistry(JSON.parse(readFileSync(args.registryPath, 'utf8')));
    if (!parsed.ok) {
      throw new Error(`registry 解析失败：${parsed.issues.map((i) => i.detail).join(' / ')}`);
    }
    registry = parsed.registry;
  }

  const client = postgres(args.targetUrl, {
    max: 2,
    connection: { application_name: APPLY_APP_NAME },
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  const fence = advisoryFence(args.targetUrl);
  try {
    const revisionContracts = await loadRevisionContracts(db, registry);
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
    const result = await runMigrationApply({
      db,
      plan,
      runId,
      fence: fence as MigrationApplyFence,
      batchSize: args.batchSize ?? 200,
    });
    const reportPath = join(args.artifactsDir, applyReportFileName(runId));
    writeFileSync(
      reportPath,
      `${JSON.stringify({ ...result.report, worklists_detail: plan.worklists }, null, 2)}\n`,
    );
    return {
      runId,
      reportPath,
      phases: result.report.phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        rows_written: p.rows_written,
        rows_already_present: p.rows_already_present,
      })),
      reconciliation: {
        mapping_rows_superseded_in_run: result.report.reconciliation.mapping_rows_superseded_in_run,
        divergences: result.report.reconciliation.divergences,
      },
    };
  } finally {
    await fence.close().catch(() => undefined);
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** 等条件成立（上限 tries×intervalMs；超时返回 false）。 */
async function waitFor(fn: () => Promise<boolean>, tries = 200, intervalMs = 25) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 隔离演练主流程。 */
export async function runRehearsal(opts: RehearsalOptions): Promise<RehearsalReport> {
  const steps: StepRecord[] = [];
  const log = makeLogger(opts.out);
  const artifacts: Record<string, string> = {};
  const acceptance: RehearsalReport['acceptance'] = {
    restore_proof: false,
    migration_idempotent: false,
    fault_recovery: false,
    rollback_boundary_a: false,
    rollback_boundary_b: false,
    cutover_window_measured: false,
    failure_handling_recorded: false,
  };

  const pg = await startEphemeralPg();
  const conn = pg.connect(pg.database);
  const db = conn.db;
  const close = conn.close;
  try {
    const dbName = pg.database;
    const targetUrl = pg.urlFor(dbName);
    const restoreDb = 'rehearsal_restore';
    const rollbackDb = 'rehearsal_rollback';
    const clock = new CutoverClock(db);

    // ── 01 provision + migrate ──────────────────────────────────────────
    await stepRun(steps, log, 'provision', async () => {
      await pg.migrate(dbName);
      const marker = await pg.psql(
        dbName,
        `select epoch || '/' || state from contract_epoch order by seq desc limit 1`,
      );
      return { db: dbName, image: REHEARSAL_PG_IMAGE, epoch: marker };
    });

    // ── 02 seed + isolated blobs ────────────────────────────────────────
    const blobStore = isolatedBlobStore(join(opts.out, 'blobs'));
    await stepRun(steps, log, 'seed', async () => {
      const manifest = await seedRehearsalCorpus(db);
      await seedContractCorpus(db);
      // 隔离 blob：source_asset 行引用的两张图（内容合成；sha256 回写行内，
      // 保持「行引用 ↔ blob 内容」一致闭环）。
      const pngMain = Buffer.from(`fixture-png-main-${'x'.repeat(4000)}`);
      const pngFig = Buffer.from(`fixture-png-fig-${'y'.repeat(4000)}`);
      await blobStore.put('answers/asset-answer-1.png', pngMain);
      await blobStore.put('figures/asset-fig-1.png', pngFig);
      const inv = blobStore.inventory();
      const shaOf = (key: string) => inv.find((i) => i.key === key)?.sha256 ?? '';
      await db.execute(
        sql`update source_asset set sha256 = ${shaOf('answers/asset-answer-1.png')} where id = 'asset-answer-1'`,
      );
      await db.execute(
        sql`update source_asset set sha256 = ${shaOf('figures/asset-fig-1.png')} where id = 'asset-fig-1'`,
      );
      writeProof(opts.out, 'seed-manifest.json', { manifest, blobs: inv });
      return { tables: manifest.tables, blobs: inv.length };
    });

    // ── 03 backup（生产 dump 形态：容器内 pg_dump -Fc） ──────────────────
    const preBackup = await snapshotDbState(db);
    writeProof(opts.out, 'state-pre-dump.json', preBackup);
    const dumpPath = `/tmp/rehearsal-${Date.now()}.dump`;
    await stepRun(steps, log, 'backup', async () => {
      const dump = await pg.pgDump(dbName, dumpPath);
      const hostDump = join(opts.out, 'backup.dump');
      await pg.exportDump(dumpPath, hostDump);
      artifacts['backup.dump'] = hostDump;
      return dump;
    });

    // ── 04 restore-proof（= rollback 边界 a 的载体） ─────────────────────
    await stepRun(steps, log, 'restore-proof', async () => {
      await pg.createDatabase(restoreDb);
      await pg.pgRestore(restoreDb, dumpPath);
      const { db: rdb, close: rclose } = pg.connect(restoreDb);
      try {
        const post = await snapshotDbState(rdb);
        writeProof(opts.out, 'state-post-restore.json', post);
        const diff = diffDbStates(preBackup, post);
        writeProof(opts.out, 'restore-diff.json', diff);
        if (!diff.identical) {
          throw new Error(`restore diff non-empty: ${diff.divergences.join('; ')}`);
        }
        acceptance.restore_proof = true;
        acceptance.rollback_boundary_a = true;
        return { restored_to: restoreDb, identical: true };
      } finally {
        await rclose();
      }
    });

    // ── 05 capture（含幂等重跑：第二遍工件 already-present） ─────────────
    const artifactsDir = join(opts.out, 'artifacts');
    await stepRun(steps, log, 'capture', async () => {
      const { runMigrationCapture } = await import('../../../scripts/migration-capture');
      const first = await runMigrationCapture({
        out: artifactsDir,
        target: targetUrl,
        redact: false,
        appImage: null,
        workerImage: null,
        gitSha: null,
      });
      const second = await runMigrationCapture({
        out: artifactsDir,
        target: targetUrl,
        redact: false,
        appImage: null,
        workerImage: null,
        gitSha: null,
      });
      return {
        artifactsDir,
        checkpoint: first.checkpointHash,
        rerun_same_checkpoint: second.checkpointHash === first.checkpointHash,
        rerun_capture_status: second.captureStatus,
      };
    });

    // ── 06 window-open（begin_prepare + stale writer + fence 探针） ──────
    await stepRun(steps, log, 'window-open', async () => {
      const report = await clock.step('window-open', async () => {
        const lock = await simulateStaleWriterLock(targetUrl, db);
        writeProof(opts.out, 'failure-lock.json', lock);
        await transitionContractEpoch(
          db,
          'begin_prepare',
          'assessment-contract-v1',
          'rehearsal',
          'maintenance window opened',
        );
        const fenced = await probeEpochFence(db);
        writeProof(opts.out, 'fence-preparing.json', fenced);
        return {
          lock_wait_observed: lock.lock_wait_observed,
          recovered_after_terminate: lock.recovered_after_terminate,
          api_fenced: fenced.api_gate_rejected,
          job_fenced: fenced.job_delivery_fenced,
        };
      });
      acceptance.failure_handling_recorded =
        Boolean(report.lock_wait_observed) &&
        Boolean(report.recovered_after_terminate) &&
        Boolean(report.api_fenced) &&
        Boolean(report.job_fenced);
      return report as Record<string, unknown>;
    });

    // ── 07 migrate-apply（崩溃注入 + 单写者 + 幂等 + supersession） ───────
    await stepRun(steps, log, 'migrate-apply', async () => {
      return clock.step('migrate-apply', async (): Promise<Record<string, unknown>> => {
        const registryPath = join(opts.out, 'registry.json');
        writeFileSync(registryPath, `${JSON.stringify(buildRehearsalRegistry(), null, 2)}\n`);
        artifacts['registry.json'] = registryPath;

        // 7a. 首次 apply（无 registry → pending 基线），执行中途把 apply 的
        //     backend 全部 terminate（连接崩溃 ≈ 进程崩溃/断电的 DB 侧形态），
        //     然后同参数重跑 —— phase ledger 收敛到 completed。
        const { loadMigrationArtifacts } = await import('../../../scripts/migration-apply');
        const { manifest } = loadMigrationArtifacts(artifactsDir);
        const firstRunId = applyRunIdOf({
          checkpoint_hash: manifest.checkpoint_hash,
          classification_hash: manifest.classification.classification_hash,
          registry_digest: null,
        });

        const applyPromise = applyOnce({
          targetUrl,
          artifactsDir,
          registryPath: null,
          batchSize: 1, // 拉长执行窗口，让崩溃注入确定性落在写阶段中途
        });

        // 触发点：phase ledger 出现 'running' 行（已过 fence、已进入阶段执行）
        // → terminate 该 run 的全部 apply backend（fence + worker 连接）。
        const sawRunning = await waitFor(async () => {
          const rows = await db.execute(
            sql`select count(*)::int as n from migration_apply_phase
                where run_id = ${firstRunId} and status = 'running'`,
          );
          return Number((rows[0] as { n: number }).n) > 0;
        });
        let crashInjected = false;
        let crashError: string | null = null;
        if (sawRunning) {
          await db.execute(
            sql`select pg_terminate_backend(pid) from pg_stat_activity
                where application_name = ${APPLY_APP_NAME} and pid <> pg_backend_pid()`,
          );
          crashInjected = true;
        }
        try {
          await applyPromise;
        } catch (err) {
          crashError = err instanceof Error ? err.message : String(err);
        }
        // 崩溃证据：run 行停在 'running'/'failed'（绝不是 completed）。
        const deadRunRows = await db.execute(
          sql`select status from migration_apply_run where run_id = ${firstRunId}`,
        );
        const deadStatus = (deadRunRows[0] as { status: string } | undefined)?.status ?? 'absent';

        // resume：同 checkpoint/同分类重跑 —— 已完成 phase skip，崩溃 phase 重做。
        const resumed = await applyOnce({ targetUrl, artifactsDir, registryPath: null });
        const resumedStatuses = resumed.phases.map((p) => `${p.phase}:${p.status}`);

        // 7b. 单写者纪律：持有 advisory fence 时 apply 必须被拒（并行第二
        //     写者不得介入 —— 生产对应物：两个维护窗口实例互踩）。
        const fenceClient = postgres(targetUrl, {
          max: 1,
          connection: { application_name: 'yuk1057-stale-apply' },
        });
        let fenceRejection: { held: boolean; apply_rejected: boolean; error: string | null };
        try {
          const acq =
            await fenceClient`select pg_try_advisory_lock(hashtext('yuk1050:migration-apply')) as ok`;
          const held = acq[0]?.ok === true;
          let rejected = false;
          let rejErr: string | null = null;
          if (held) {
            try {
              await applyOnce({ targetUrl, artifactsDir, registryPath: null });
            } catch (err) {
              rejected = true;
              rejErr = err instanceof Error ? err.message : String(err);
            }
          }
          fenceRejection = { held, apply_rejected: rejected, error: rejErr };
        } finally {
          await fenceClient.end({ timeout: 5 }).catch(() => undefined);
        }

        // 7c. 幂等重跑（同 run 已 completed → 全 phases skipped、零写入）。
        const idempotent = await applyOnce({ targetUrl, artifactsDir, registryPath: null });
        const idempotentZeroWrite =
          idempotent.phases.length > 0 &&
          idempotent.phases.every((p) => p.status === 'skipped' && p.rows_written === 0);

        // 7d. registry 版重跑（新 runId：registry_digest 入 run 身份；
        //     awaiting_revision_registry worklist → resolved，supersession 入对账）。
        const withRegistry = await applyOnce({ targetUrl, artifactsDir, registryPath });
        const supersededInRun = withRegistry.reconciliation.mapping_rows_superseded_in_run;

        acceptance.migration_idempotent = idempotentZeroWrite;
        acceptance.fault_recovery =
          crashInjected &&
          crashError !== null &&
          deadStatus !== 'completed' &&
          resumed.reconciliation.divergences.length === 0;

        return {
          first_run_id: firstRunId,
          crash: {
            injected: crashInjected,
            saw_running_phase: sawRunning,
            error: crashError,
            run_status_after_crash: deadStatus,
          },
          resume: { run_id: resumed.runId, phases: resumedStatuses },
          fence_rejection: fenceRejection,
          idempotent_rerun: {
            run_id: idempotent.runId,
            all_phases_skipped: idempotentZeroWrite,
          },
          registry_rerun: {
            run_id: withRegistry.runId,
            superseded_rows_in_run: supersededInRun,
            divergences: withRegistry.reconciliation.divergences,
          },
        };
      });
    });

    // ── 08 mark-ready（ready 下仍 fenced = 安静窗口证据） ─────────────────
    await stepRun(steps, log, 'mark-ready', async () => {
      return clock.step('mark-ready', async (): Promise<Record<string, unknown>> => {
        await transitionContractEpoch(db, 'mark_ready', 'assessment-contract-v1', 'rehearsal');
        const fenced = await probeEpochFence(db);
        const gate = await checkContractEpoch(db);
        return {
          api_fenced: fenced.api_gate_rejected,
          job_fenced: fenced.job_delivery_fenced,
          gate_reason: gate.runnable ? 'runnable' : (gate.reason ?? 'unknown'),
        };
      });
    });

    // ── 09 activate（window 关闭；epoch_mismatch 证据 = 旧代码不得跑） ─────
    await stepRun(steps, log, 'activate', async () => {
      return clock.step('activate', async (): Promise<Record<string, unknown>> => {
        await transitionContractEpoch(db, 'activate', 'assessment-contract-v1', 'rehearsal');
        const gate = await checkContractEpoch(db);
        return {
          epoch: gate.marker?.epoch ?? 'legacy(implicit)',
          state: gate.marker?.state ?? 'active',
          code_epoch_fenced: !gate.runnable,
          reason: gate.runnable ? 'runnable' : (gate.reason ?? 'unknown'),
        };
      });
    });

    // ── 10 post-writes（真实 writer seam） ──────────────────────────────
    const pw = await stepRun(steps, log, 'post-writes', async () => {
      const handle = await simulatePostCutoverWrites(db);
      writeProof(opts.out, 'post-writes.json', handle);
      return { handle: handle as unknown as Record<string, unknown> };
    });
    const handle = pw.detail.handle as unknown as PostWriteHandle;

    // ── 11 delta-export ────────────────────────────────────────────────
    await stepRun(steps, log, 'delta-export', async () => {
      const d = await exportPostWriteDelta(db, handle);
      writeProof(opts.out, 'postwrite-delta.json', d);
      artifacts['postwrite-delta.json'] = join(opts.out, 'postwrite-delta.json');
      return {
        tables: Object.fromEntries(Object.entries(d.rows).map(([k, v]) => [k, v.length])),
        watermark: d.event_watermark,
      };
    });

    // ── 12 rollback-b（独立库 restore → replay → 对账） ──────────────────
    await stepRun(steps, log, 'rollback-b', async () => {
      await pg.createDatabase(rollbackDb);
      await pg.pgRestore(rollbackDb, dumpPath);
      const { db: rdb, close: rclose } = pg.connect(rollbackDb);
      try {
        const delta = JSON.parse(
          readFileSync(join(opts.out, 'postwrite-delta.json'), 'utf8'),
        ) as PostWriteDelta;
        await replayPostWriteDelta(rdb, delta);
        const recon = await reconcilePostWriteDelta(rdb, delta);
        writeProof(opts.out, 'rollback-b-reconcile.json', recon);
        acceptance.rollback_boundary_b = recon.identical;
        return {
          rollback_target: rollbackDb,
          identical: recon.identical,
          tables_checked: recon.tables_checked,
          divergences: recon.divergences,
        };
      } finally {
        await rclose();
      }
    });

    // ── 13 window close + report ────────────────────────────────────────
    const windowReport = clock.report();
    writeProof(opts.out, 'cutover-window.json', windowReport);
    artifacts['cutover-window.json'] = join(opts.out, 'cutover-window.json');
    acceptance.cutover_window_measured = windowReport.steps.length >= 3;

    const report: RehearsalReport = {
      run_at: new Date().toISOString(),
      out_dir: opts.out,
      steps,
      acceptance,
      artifacts,
    };
    writeProof(opts.out, 'report.json', report);
    return report;
  } finally {
    await close().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  }
}
