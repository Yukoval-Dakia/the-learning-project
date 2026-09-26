import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedKnowledge } from '@/capabilities/knowledge/server/seed';
import { runEvalHarness, stubInvoker } from '@/core/eval/d18-harness';
import { buildMigrationApplyPlan } from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { ai_task_runs, assessment_submission, migration_apply_run } from '@/db/schema';
import { checkContractEpoch, transitionContractEpoch } from '@/server/contract-epoch';
import {
  type MigrationApplyFence,
  assertReconciliationClean,
  runMigrationApply,
} from '@/server/migration/apply';
import { captureMigrationCheckpoint } from '@/server/migration/capture';
import { loadRevisionContracts } from '../../../scripts/migration-apply';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { D18_TASK_KIND, aiTaskRunEvidenceSink } from '../eval/d18-seal';
import { buildRehearsalRegistry, seedContractCorpus } from './contract-corpus';
import { seedRehearsalCorpus } from './corpus';
import { probeEpochFence, simulateStaleWriterLock } from './cutover';
import { diffDbStates, snapshotDbState } from './db-proof';
import {
  exportPostWriteDelta,
  reconcilePostWriteDelta,
  replayPostWriteDelta,
  simulatePostCutoverWrites,
} from './post-write';

// YUK-1057 — 隔离演练 DB 测试：与 orchestrate.ts 同缝的逐组件验证
// （ephemeral 容器/runRehearsal 全流程本身由 scripts/rehearsal.ts 手动驱动，
// 这里钉住每个 seam 在真 PG 上的契约）。

const FENCE: MigrationApplyFence = { acquire: async () => true, release: async () => undefined };

async function planInput(db: Db, registry: ReturnType<typeof buildRehearsalRegistry> | null) {
  const capture = await captureMigrationCheckpoint(db);
  const classification = classifyMigrationCapture(capture);
  const contracts = await loadRevisionContracts(db, registry);
  return {
    capture,
    classification: {
      classification_version: 'rehearsal-test',
      classification_hash: canonicalHash({
        classification_version: 'rehearsal-test',
        records: classification.records,
        unresolved: classification.unresolved,
        deferred_replay: classification.deferred_replay,
      }),
      records: classification.records,
      unresolved: classification.unresolved,
      deferred_replay: classification.deferred_replay,
    },
    checkpoint_hash: 'chk-rehearsal-test',
    registry,
    revisionContracts: contracts,
  };
}

describe('rehearsal corpus → capture → apply（orchestrate 同缝）', () => {
  beforeEach(async () => {
    await resetDb();
    // 与 scripts/migrate.ts 同缝：builtin 科目根（seed:math:root）先落，
    // corpus 子卡才有合法 parent 锚。
    await seedKnowledge(testDb());
    await seedRehearsalCorpus(testDb());
    await seedContractCorpus(testDb());
  });

  it('无 registry apply 落 pending 基线；幂等重跑全 phases skipped；registry 重跑收敛', async () => {
    const db = testDb();
    const input = await planInput(db, null);
    const plan = buildMigrationApplyPlan(input);
    expect(plan.records.length).toBeGreaterThan(0);
    // 语料必须有真实分类面（complete/pending/historical 各至少一条 ——
    // 不是空跑语料）。
    const cats = new Set(input.classification.records.map((r) => r.category));
    expect(cats.has('complete_attempt')).toBe(true);
    expect(cats.has('pending_blocked')).toBe(true);
    expect(cats.has('historical_unresolved')).toBe(true);
    // 无 registry 的 apply = pending 基线：映射登记、submission 一律不写。
    expect(plan.rollup.mapping_status.pending ?? 0).toBeGreaterThan(0);
    expect(plan.rollup.mapping_status.mapped ?? 0).toBe(0);
    expect(plan.rollup.totals.submissions).toBe(0);
    // 语料含真 unresolved（纠正链闭包 → 保持 unresolved，不得绑定）。
    expect(input.classification.unresolved.length).toBeGreaterThan(0);
    const runId = 'run-rehearsal-0000000000000001';
    const first = await runMigrationApply({ db, plan, runId, fence: FENCE, batchSize: 1 });
    assertReconciliationClean(first.report);
    expect(first.report.phases.every((p) => p.status === 'completed')).toBe(true);
    const written = first.report.phases.reduce((acc, p) => acc + p.rows_written, 0);
    expect(written).toBeGreaterThan(0);

    // 幂等重跑：全 phases skipped、零写入、对账仍干净。
    const rerun = await runMigrationApply({ db, plan, runId, fence: FENCE, batchSize: 1 });
    expect(rerun.report.phases.every((p) => p.status === 'skipped' && p.rows_written === 0)).toBe(
      true,
    );
    assertReconciliationClean(rerun.report);

    // registry 版重跑：新 run（registry_digest 变 → run_id 变）。
    const registry = buildRehearsalRegistry();
    const input2 = await planInput(db, registry);
    const plan2 = buildMigrationApplyPlan(input2);
    // registry 解析出 mapped 绑定 + 至少一条忠实重建 submission 链
    // （complete_attempt 锚 + 判词证据）。
    expect(plan2.rollup.mapping_status.mapped ?? 0).toBeGreaterThan(0);
    expect(plan2.rollup.totals.submissions).toBeGreaterThan(0);
    const withReg = await runMigrationApply({
      db,
      plan: plan2,
      runId: 'run-rehearsal-0000000000000002',
      fence: FENCE,
      batchSize: 1,
    });
    assertReconciliationClean(withReg.report);
    const runs = await db.select().from(migration_apply_run);
    expect(runs.filter((r) => r.status === 'completed').length).toBe(2);
    // pending→resolved supersession 真实发生（账本计数，非 stdout 解析）。
    expect(withReg.report.reconciliation.mapping_rows_superseded_in_run).toBeGreaterThan(0);
  });

  it('post-cutover 写入 → delta 导出 → 独立 rollback 库回放 + 对账（边界 b）', async () => {
    const db = testDb();
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set');
    const forkName = new URL(url).pathname.slice(1);
    const rollbackName = `${forkName}_reh_rollback`;

    // 边界 b 的 restore 面：post-writes 之前先建一个「旧 dump」等价物。
    // CREATE DATABASE … TEMPLATE 是生产支持的真实克隆路径；模板库上不能
    // 有活动连接 —— 先从 maintenance db 驱逐本 fork 的连接（testDb 池惰性
    // 重连，重放期间不受影响）。
    const admin = postgres(
      (() => {
        const u = new URL(url);
        u.pathname = '/postgres';
        return u.toString();
      })(),
      { max: 1 },
    );
    try {
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${forkName} and pid <> pg_backend_pid()`;
      await admin`drop database if exists ${admin(rollbackName)}`;
      await admin`create database ${admin(rollbackName)} template ${admin(forkName)}`;
    } finally {
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }

    const handle = await simulatePostCutoverWrites(db);
    expect(handle.event_watermark).toBeGreaterThanOrEqual(0);
    const delta = await exportPostWriteDelta(db, handle);
    expect(delta.rows.question?.length).toBe(1);
    expect(delta.rows.assessment_submission?.length).toBe(1);
    expect((delta.rows.event ?? []).length).toBeGreaterThan(0);

    // replay 走独立 rollback 库（克隆面 = pre-write 态，不含 pw-* 行；
    // immutable guard 不需要删除任何东西 —— 这是真实回滚边界形状）。
    const rollbackClient = postgres(
      (() => {
        const u = new URL(url);
        u.pathname = `/${rollbackName}`;
        return u.toString();
      })(),
      { max: 2 },
    );
    const rollbackDb = drizzle(rollbackClient, { schema }) as unknown as Db;
    try {
      // 面检查：rollback 库不含 post-write 组/事件。
      const preSub = await rollbackDb
        .select()
        .from(assessment_submission)
        .where(eq(assessment_submission.submission_id, handle.submission_id));
      expect(preSub.length).toBe(0);
      await replayPostWriteDelta(rollbackDb, delta);
      const recon = await reconcilePostWriteDelta(rollbackDb, delta);
      expect(recon.divergences).toEqual([]);
      expect(recon.identical).toBe(true);
    } finally {
      await rollbackClient.end({ timeout: 5 }).catch(() => undefined);
      const cleanup = postgres(
        (() => {
          const u = new URL(url);
          u.pathname = '/postgres';
          return u.toString();
        })(),
        { max: 1 },
      );
      try {
        await cleanup`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${rollbackName} and pid <> pg_backend_pid()`;
        await cleanup`drop database if exists ${cleanup(rollbackName)}`;
      } finally {
        await cleanup.end({ timeout: 5 }).catch(() => undefined);
      }
    }
  });

  it('snapshotDbState 同库自比恒 identical（restore-proof 的对照面）', async () => {
    const db = testDb();
    const a = await snapshotDbState(db);
    const diff = diffDbStates(a, a);
    expect(diff.identical).toBe(true);
    expect(diff.divergences).toEqual([]);
  });

  it('stale writer 持表锁 → 超时证据 → terminate 恢复（cutover.ts seam）', async () => {
    const db = testDb();
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) throw new Error('TEST_DATABASE_URL not set');
    const r = await simulateStaleWriterLock(url, db, 'assessment_submission');
    expect(r.lock_wait_observed).toBe(true);
    expect(r.terminated_pid).toBeGreaterThan(0);
    expect(r.recovered_after_terminate).toBe(true);
  });

  it('epoch 栅栏三态：preparing/ready 拒跑，activate 后 legacy 代码 epoch_mismatch', async () => {
    const db = testDb();
    // 空表 = 隐式 legacy/active → runnable。
    const pre = await checkContractEpoch(db);
    expect(pre.runnable).toBe(true);

    await transitionContractEpoch(db, 'begin_prepare', 'assessment-contract-v1', 'test');
    const duringPrep = await checkContractEpoch(db);
    expect(duringPrep.runnable).toBe(false);
    expect(duringPrep.reason).toBe('maintenance');
    const fenced = await probeEpochFence(db);
    expect(fenced.api_gate_rejected).toBe(true);
    expect(fenced.job_delivery_fenced).toBe(true);

    await transitionContractEpoch(db, 'mark_ready', 'assessment-contract-v1', 'test');
    const ready = await checkContractEpoch(db);
    expect(ready.runnable).toBe(false);
    expect(ready.reason).toBe('maintenance');

    await transitionContractEpoch(db, 'activate', 'assessment-contract-v1', 'test');
    const post = await checkContractEpoch(db);
    // 本二进制 code epoch = legacy → active 后仍拒，reason 变 epoch_mismatch
    // （正是演练证据：旧代码不得在 post-cutover DB 上跑）。
    expect(post.runnable).toBe(false);
    expect(post.reason).toBe('epoch_mismatch');
    expect(post.marker?.epoch).toBe('assessment-contract-v1');
  });
});

describe('D18 ai_task_runs 封存（orchestrate/eval-d18 同缝）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('harness × aiTaskRunEvidenceSink：每 invocation 一行、digest/usage/成本照实入账、同 id 不覆盖', async () => {
    const db = testDb();
    const sink = aiTaskRunEvidenceSink(db, { provider: 'stub' });
    const corpus = [
      { id: 'item-a', split: 'dev' as const, request: { prompt: 'p1' } },
      { id: 'item-b', split: 'holdout' as const, request: { prompt: 'p2' } },
    ];
    const report = await runEvalHarness({
      runId: 'sealtest',
      corpus,
      invoker: stubInvoker({ lane: 'stub', costUsd: 0.001 }),
      sink,
    });
    expect(report.invocations).toBe(2);

    const rows = await db.select().from(ai_task_runs);
    const sealed = rows.filter((r) => r.task_kind === D18_TASK_KIND);
    expect(sealed).toHaveLength(2);
    for (const row of sealed) {
      expect(row.id).toMatch(/^d18-sealtest-item-[ab]-a1$/);
      expect(row.status).toBe('success');
      expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.result_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(row.cost_usd).toBeCloseTo(0.001);
      expect(row.cost_basis).toBe('reported');
      expect(row.provider).toBe('stub');
      expect((row.usage_json as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
    }
    // 证据行不可变：同 id 重放不覆盖。
    const again = aiTaskRunEvidenceSink(db, { provider: 'stub' });
    const report2 = await runEvalHarness({
      runId: 'sealtest',
      corpus,
      invoker: stubInvoker({ lane: 'stub', costUsd: 0.999 }),
      sink: again,
    });
    expect(report2.invocations).toBe(2);
    const sealed2 = await db.select().from(ai_task_runs).where(sql`task_kind = ${D18_TASK_KIND}`);
    expect(sealed2).toHaveLength(2);
    // float4 回读：≈0.001 即未被第二次（0.999）覆盖。
    expect(sealed2.every((r) => Math.abs((r.cost_usd ?? 0) - 0.001) < 1e-6)).toBe(true);
  });
});
