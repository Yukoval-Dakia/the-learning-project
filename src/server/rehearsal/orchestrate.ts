// Every step stays in the ephemeral container. Never touch a running compose.
// Capture, apply, and epoch transitions call the real code in process. Do not parse their stdout.
// Apply connections use application_name='yuk1057-apply'. Terminate those backends only after a
// phase ledger row is 'running'. The fence connection is separate, so the orchestrator stays up.
// Restore-proof is rollback boundary (a), before new writes. Boundary (b) restores an independent
// database and replays the post-write delta. Legacy epoch_mismatch is asserted in
// rehearsal.db.test.ts, not here. ready still fences. That quiet window is part of the cutover.

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

// Crash injection terminates this name and leaves the orchestrator's own connection alone.
const APPLY_APP_NAME = 'yuk1057-apply';

export interface RehearsalOptions {
  /** Absolute artifact root. */
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
 * Same path as scripts/migration-apply.ts. The report lands in artifactsDir.
 * The fence opens its own connection, and the URL cannot tag that one, so injection
 * waits for a phase ledger 'running' row. By then the fence and the worker pool are
 * both up, and the lock is released when those connections die.
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

async function waitFor(fn: () => Promise<boolean>, tries = 200, intervalMs = 25) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

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

    await stepRun(steps, log, 'provision', async () => {
      await pg.migrate(dbName);
      const marker = await pg.psql(
        dbName,
        `select epoch || '/' || state from contract_epoch order by seq desc limit 1`,
      );
      return { db: dbName, image: REHEARSAL_PG_IMAGE, epoch: marker };
    });

    const blobStore = isolatedBlobStore(join(opts.out, 'blobs'));
    await stepRun(steps, log, 'seed', async () => {
      const manifest = await seedRehearsalCorpus(db);
      await seedContractCorpus(db);
      // Synthetic bytes. The sha256 is written back so the source_asset row matches the file.
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

    await stepRun(steps, log, 'migrate-apply', async () => {
      return clock.step('migrate-apply', async (): Promise<Record<string, unknown>> => {
        const registryPath = join(opts.out, 'registry.json');
        writeFileSync(registryPath, `${JSON.stringify(buildRehearsalRegistry(), null, 2)}\n`);
        artifacts['registry.json'] = registryPath;

        // First apply has no registry, so the baseline stays pending. Terminate every
        // apply backend mid-run, then rerun the same args until the ledger is completed.
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
          batchSize: 1, // Widen the write so the crash lands mid-phase.
        });

        // A 'running' phase row means the fence is held and the phase has started.
        // Terminate every apply backend for this run. The lock dies with the connection.
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
        // Crash evidence: the run row is running or failed, never completed.
        const deadRunRows = await db.execute(
          sql`select status from migration_apply_run where run_id = ${firstRunId}`,
        );
        const deadStatus = (deadRunRows[0] as { status: string } | undefined)?.status ?? 'absent';

        // Same checkpoint and classification. Finished phases skip. The crashed phase reruns.
        const resumed = await applyOnce({ targetUrl, artifactsDir, registryPath: null });
        const resumedStatuses = resumed.phases.map((p) => `${p.phase}:${p.status}`);

        // A second writer must be refused while the advisory fence is held.
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

        // The completed run reruns with every phase skipped and zero rows written.
        const idempotent = await applyOnce({ targetUrl, artifactsDir, registryPath: null });
        const idempotentZeroWrite =
          idempotent.phases.length > 0 &&
          idempotent.phases.every((p) => p.status === 'skipped' && p.rows_written === 0);

        // registry_digest is part of run identity, so this is a new runId.
        // awaiting_revision_registry resolves, and supersession lands in the reconciliation.
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

    await stepRun(steps, log, 'activate', async () => {
      return clock.step('activate', async (): Promise<Record<string, unknown>> => {
        await transitionContractEpoch(db, 'activate', 'assessment-contract-v1', 'rehearsal');
        const gate = await checkContractEpoch(db);
        return {
          epoch: gate.marker?.epoch ?? 'implicit(code-epoch)',
          state: gate.marker?.state ?? 'active',
          code_epoch_fenced: !gate.runnable,
          reason: gate.runnable ? 'runnable' : (gate.reason ?? 'unknown'),
        };
      });
    });

    const pw = await stepRun(steps, log, 'post-writes', async () => {
      const handle = await simulatePostCutoverWrites(db);
      writeProof(opts.out, 'post-writes.json', handle);
      return { handle: handle as unknown as Record<string, unknown> };
    });
    const handle = pw.detail.handle as unknown as PostWriteHandle;

    await stepRun(steps, log, 'delta-export', async () => {
      const d = await exportPostWriteDelta(db, handle);
      writeProof(opts.out, 'postwrite-delta.json', d);
      artifacts['postwrite-delta.json'] = join(opts.out, 'postwrite-delta.json');
      return {
        tables: Object.fromEntries(Object.entries(d.rows).map(([k, v]) => [k, v.length])),
        watermark: d.event_watermark,
      };
    });

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
