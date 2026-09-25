import { inArray, sql } from 'drizzle-orm';

import {
  type MigrationApplyPlan,
  type SubmissionChainPlan,
  planDigestOf,
} from '@/core/migration/apply';
import type { Db } from '@/db/client';
import {
  assessment_identity_mapping,
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  migration_apply_phase,
  migration_apply_run,
  question_revision,
} from '@/db/schema';

// ====================================================================
// YUK-1050 — 历史迁移 apply · DB 执行器（grounding §15）
// ====================================================================
//
// 消费纯规划器（core/migration/apply.ts）的 MigrationApplyPlan，分阶段幂等
// 落库：preflight → plan → apply_mappings → apply_submissions → reconcile。
//
// 纪律：
//   - 单写者 fence：advisory lock（跨阶段持有；由调用方提供专用连接实现，
//     池化连接上的 session lock 会在连接归还时释放，不能作 fence）。
//   - 幂等：一切主键内容寻址派生 + INSERT ... ON CONFLICT DO NOTHING；
//     已存在的行做内容对账（divergence fail-visible，绝不覆盖 —— guarded
//     表的 UPDATE/DELETE 由 0105/0106/0107 trigger 拒绝，这里也不尝试）。
//   - crash 续跑：阶段进度入账本（migration_apply_run/phase）；重跑跳过
//     completed 阶段，未完成阶段靠幂等收敛。
//   - 观测：每阶段 duration、rows_written/already_present、WAL LSN 位移
//     （权限不足时为 null —— 不冒充）。
//   - 无学习重放：写面仅限 6 张评估真相表 + 2 张账本表；FSRS/θ̂/calibration
//     等学习状态表零触碰（reconciliation 报告显式声明）。
//
// 本模块不做 DB epoch/启动 fence（YUK-1055 lane）；advisory fence 只防
// 并发执行器，不防旧 writer —— cutover runbook 负责停全部 writer。

export type ApplyPhaseName =
  | 'preflight'
  | 'plan'
  | 'apply_mappings'
  | 'apply_submissions'
  | 'reconcile';

const PHASE_ORDER: readonly ApplyPhaseName[] = [
  'preflight',
  'plan',
  'apply_mappings',
  'apply_submissions',
  'reconcile',
];

/** 单写者 fence：acquire 持有至 release（专用连接；池化连接不可用）。 */
export interface MigrationApplyFence {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export interface MigrationApplyArgs {
  db: Db;
  plan: MigrationApplyPlan;
  runId: string;
  /** 非 dry-run 必须提供 fence（fail-visible：无 fence 拒绝写库）。 */
  fence: MigrationApplyFence | null;
  dryRun?: boolean;
  batchSize?: number;
  now?: () => Date;
}

export interface PhaseOutcome {
  phase: ApplyPhaseName;
  status: 'completed' | 'skipped' | 'failed';
  duration_ms: number;
  rows_written: number;
  rows_already_present: number;
  wal_bytes: number | null;
  error: string | null;
}

export interface ApplyReconciliationReport {
  run_id: string;
  checkpoint_hash: string;
  classification_hash: string;
  classification_version: string;
  registry_digest: string | null;
  plan_digest: string;
  algorithm_version: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  phases: PhaseOutcome[];
  plan_totals: MigrationApplyPlan['rollup']['totals'];
  mapping_status_plan: MigrationApplyPlan['rollup']['mapping_status'];
  reconciliation: {
    mapping_rows_planned: number;
    mapping_rows_present: number;
    mapping_rows_present_by_status: Record<string, number>;
    issuances_planned: number;
    issuances_present: number;
    groups_planned: number;
    groups_present: number;
    submissions_planned: number;
    submissions_present: number;
    evaluations_planned: number;
    evaluations_present: number;
    heads_planned: number;
    heads_present: number;
    divergences: string[];
    learning_tables_touched: 'none (by construction)';
  };
  worklists: {
    unresolved: number;
    deferred_replay: number;
    awaiting_revision_registry: number;
    conflicted: number;
  };
}

export class MigrationApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationApplyError';
  }
}

// ───────────────────────── 观测原语 ─────────────────────────

async function currentWalLsn(db: Db): Promise<string | null> {
  try {
    const result = await db.execute<{ lsn: string | null }>(
      sql`select pg_current_wal_lsn()::text as lsn`,
    );
    const rows = (result as unknown as { rows?: Array<{ lsn: string | null }> }).rows ?? [];
    return rows[0]?.lsn ?? null;
  } catch {
    // 权限不足（如受限角色）—— 观测降级为 null，不冒充。
    return null;
  }
}

function lsnToBytes(lsn: string): number | null {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn);
  if (match === null) return null;
  const hi = match[1];
  const lo = match[2];
  if (hi === undefined || lo === undefined) return null;
  return parseInt(hi, 16) * 0x100000000 + parseInt(lo, 16);
}

function walDeltaBytes(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const a = lsnToBytes(start);
  const b = lsnToBytes(end);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

// ───────────────────────── 账本 ─────────────────────────

interface LedgerRunRow {
  run_id: string;
  plan_digest: string;
  status: 'running' | 'completed' | 'failed';
}

async function ensureRunRow(
  db: Db,
  plan: MigrationApplyPlan,
  runId: string,
  now: Date,
  dryRun: boolean,
): Promise<LedgerRunRow | null> {
  if (dryRun) return null;
  await db
    .insert(migration_apply_run)
    .values({
      run_id: runId,
      checkpoint_hash: plan.checkpoint_hash,
      classification_hash: plan.classification_hash,
      classification_version: plan.classification_version,
      registry_digest: plan.registry_digest,
      plan_digest: planDigestOf(plan),
      status: 'running',
      started_at: now,
    })
    .onConflictDoNothing()
    .returning({ run_id: migration_apply_run.run_id });
  const existing = await db
    .select({
      run_id: migration_apply_run.run_id,
      plan_digest: migration_apply_run.plan_digest,
      status: migration_apply_run.status,
    })
    .from(migration_apply_run)
    .where(inArray(migration_apply_run.run_id, [runId]));
  const row = existing[0];
  if (row === undefined) {
    throw new MigrationApplyError(`run row ${runId} 既未插入也读不到 —— 账本不一致`);
  }
  if (row.plan_digest !== planDigestOf(plan)) {
    throw new MigrationApplyError(
      `run ${runId} 已按不同 plan_digest 执行过（账本 ${row.plan_digest} vs 本次 ${planDigestOf(plan)}）—— 同 run 的分类/registry 变化必须走显式新 run，不得混写`,
    );
  }
  // 同 checkpoint 的其它 run 若已介入，拒绝并行第二套输入（分类刷新/registry
  // 更替属显式 supersede 工作流；新 run 与既有 run 的分类必须一致）。
  const siblings = await db
    .select({
      run_id: migration_apply_run.run_id,
      classification_hash: migration_apply_run.classification_hash,
    })
    .from(migration_apply_run)
    .where(inArray(migration_apply_run.checkpoint_hash, [plan.checkpoint_hash]));
  for (const sibling of siblings) {
    if (sibling.run_id === runId) continue;
    if (sibling.classification_hash !== plan.classification_hash) {
      throw new MigrationApplyError(
        `checkpoint ${plan.checkpoint_hash.slice(0, 12)} 已有另一 classification 的 run ${sibling.run_id} —— 分类刷新须显式处置，不得静默叠加`,
      );
    }
  }
  return row;
}

async function phaseStatusOf(
  db: Db,
  runId: string,
): Promise<Map<ApplyPhaseName, 'completed' | 'running' | 'failed' | 'skipped'>> {
  const rows = await db
    .select({ phase: migration_apply_phase.phase, status: migration_apply_phase.status })
    .from(migration_apply_phase)
    .where(inArray(migration_apply_phase.run_id, [runId]));
  return new Map(rows.map((r) => [r.phase as ApplyPhaseName, r.status]));
}

async function startPhase(
  db: Db,
  runId: string,
  phase: ApplyPhaseName,
  now: Date,
  dryRun: boolean,
  walLsn: string | null,
): Promise<void> {
  if (dryRun) return;
  await db
    .insert(migration_apply_phase)
    .values({
      id: `${runId}#${phase}`,
      run_id: runId,
      phase,
      status: 'running',
      started_at: now,
      wal_lsn_start: walLsn,
    })
    .onConflictDoNothing();
}

async function finishPhase(
  db: Db,
  runId: string,
  phase: ApplyPhaseName,
  status: 'completed' | 'failed',
  now: Date,
  durationMs: number,
  rowsWritten: number,
  rowsPresent: number,
  dryRun: boolean,
  walLsn: string | null,
  error: string | null,
): Promise<void> {
  if (dryRun) return;
  await db
    .update(migration_apply_phase)
    .set({
      status,
      finished_at: now,
      duration_ms: durationMs,
      rows_written: rowsWritten,
      rows_already_present: rowsPresent,
      wal_lsn_end: walLsn,
      error,
    })
    .where(inArray(migration_apply_phase.id, [`${runId}#${phase}`]));
}

// ───────────────────────── preflight ─────────────────────────

async function preflight(db: Db, plan: MigrationApplyPlan): Promise<void> {
  const revisionIds = [
    ...new Set(
      plan.records
        .map((r) => r.mapping?.target_revision_id ?? null)
        .filter((v): v is string => v !== null),
    ),
  ];
  if (revisionIds.length > 0) {
    const found = await db
      .select({ revision_id: question_revision.revision_id })
      .from(question_revision)
      .where(inArray(question_revision.revision_id, revisionIds));
    const foundSet = new Set(found.map((r) => r.revision_id));
    const missing = revisionIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new MigrationApplyError(
        `registry 指向的 revision 在目标库不存在（语料导入未跑或 registry 过期）：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` …共 ${missing.length} 个` : ''}`,
      );
    }
  }
}

// ───────────────────────── apply_mappings ─────────────────────────

async function applyMappings(
  db: Db,
  plan: MigrationApplyPlan,
  batchSize: number,
  dryRun: boolean,
): Promise<{ written: number; alreadyPresent: number }> {
  const rows = plan.records.flatMap((r) => (r.mapping !== null ? [r.mapping] : []));
  if (rows.length === 0 || dryRun) return { written: 0, alreadyPresent: rows.length };
  let written = 0;
  let alreadyPresent = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const inserted = await db
      .insert(assessment_identity_mapping)
      .values(
        batch.map((m) => ({
          mapping_id: m.mapping_id,
          source_kind: m.source_kind,
          source_id: m.source_id,
          source_locator: m.source_locator,
          original_question_id: m.original_question_id,
          legacy_part_ref: m.legacy_part_ref,
          snapshot_digest: m.snapshot_digest,
          target_revision_id: m.target_revision_id,
          target_part_id: m.target_part_id,
          target_slot_id: m.target_slot_id,
          evidence: m.evidence,
          algorithm_version: m.algorithm_version,
          status: m.status,
          is_current: true,
          created_at: m.created_at,
        })),
      )
      // 冲突裁决交给任意 unique violation（arbiter-less）：本表在 (source_kind,
      // source_id, source_locator) 上的唯一索引是【部分索引】（WHERE
      // is_current），当前 drizzle 版本不支持 conflict target 的 index
      // predicate（targetWhere）—— 而内容寻址 mapping_id 与 locator 三元组
      // 一一对应（同派生函数），PK 冲突与当前映射唯一索引语义重合，故
      // arbiter-less DO NOTHING 语义等价且不依赖部分索引推断。
      .onConflictDoNothing()
      .returning({ mapping_id: assessment_identity_mapping.mapping_id });
    written += inserted.length;
    alreadyPresent += batch.length - inserted.length;

    // divergence 对账：已存在的行必须与 plan 同判（fail-visible，绝不覆盖）。
    if (alreadyPresent > 0) {
      const insertedIds = new Set(inserted.map((r) => r.mapping_id));
      const batchLocators = new Map(
        batch
          .filter((m) => !insertedIds.has(m.mapping_id))
          .map((m) => [m.source_locator, m] as const),
      );
      if (batchLocators.size > 0) {
        const stored = await db
          .select({
            source_locator: assessment_identity_mapping.source_locator,
            status: assessment_identity_mapping.status,
            target_revision_id: assessment_identity_mapping.target_revision_id,
            snapshot_digest: assessment_identity_mapping.snapshot_digest,
            is_current: assessment_identity_mapping.is_current,
          })
          .from(assessment_identity_mapping)
          .where(inArray(assessment_identity_mapping.source_locator, [...batchLocators.keys()]));
        for (const row of stored) {
          const planned = batchLocators.get(row.source_locator);
          if (planned === undefined) continue;
          if (
            !row.is_current ||
            row.status !== planned.status ||
            row.target_revision_id !== planned.target_revision_id ||
            row.snapshot_digest !== planned.snapshot_digest
          ) {
            throw new MigrationApplyError(
              `mapping divergence @ ${row.source_locator}：库内 (status=${row.status}, target=${String(row.target_revision_id)}, digest=${String(row.snapshot_digest)}, is_current=${String(row.is_current)}) 与 plan (status=${planned.status}, target=${String(planned.target_revision_id)}, digest=${String(planned.snapshot_digest)}) 不符 —— 拒绝覆盖，需显式修正工作流`,
            );
          }
        }
      }
    }
  }
  return { written, alreadyPresent };
}

// ───────────────────────── apply_submissions ─────────────────────────

async function applySubmissions(
  db: Db,
  plan: MigrationApplyPlan,
  batchSize: number,
  dryRun: boolean,
): Promise<{ written: number; alreadyPresent: number }> {
  const chains = plan.records.flatMap((r) => (r.submission !== null ? [r.submission] : []));
  if (chains.length === 0 || dryRun) return { written: 0, alreadyPresent: chains.length };
  let written = 0;
  let alreadyPresent = 0;
  for (let i = 0; i < chains.length; i += batchSize) {
    const batch = chains.slice(i, i + batchSize);
    // FK 拓扑序（0105/0106 非 DEFERRABLE）：issuance/group → submission →
    // evaluation → head；单批单事务，崩即整批回滚（幂等重放收敛）。
    await db.transaction(async (tx) => {
      const issuanceInserted = await tx
        .insert(assessment_issuance)
        .values(
          batch.map((c) => ({
            issuance_id: c.issuance.issuance_id,
            revision_id: c.issuance.revision_id,
            part_ids: c.issuance.part_ids,
            material_bindings: c.issuance.material_bindings,
            option_order: c.issuance.option_order,
            container_occurrence_ref: c.issuance.container_occurrence_ref,
            claim_policy: c.issuance.claim_policy,
            claim_status: c.issuance.claim_status,
            claimed_by_ref: c.issuance.claimed_by_ref,
            issued_at: c.issuance.issued_at,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: assessment_issuance.issuance_id });
      const groupInserted = await tx
        .insert(evaluation_group)
        .values(
          batch.map((c) => ({
            evaluation_group_id: c.group.evaluation_group_id,
            submission_ids: c.group.submission_ids,
            created_at: c.group.created_at,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: evaluation_group.evaluation_group_id });
      const submissionInserted = await tx
        .insert(assessment_submission)
        .values(
          batch.map((c) => ({
            submission_id: c.submission.submission_id,
            issuance_id: c.submission.issuance_id,
            revision_id: c.submission.revision_id,
            evaluation_group_id: c.submission.evaluation_group_id,
            response_set: c.submission.response_set,
            group_evidence: c.submission.group_evidence,
            idempotency_key: c.submission.idempotency_key,
            submitted_at: c.submission.submitted_at,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: assessment_submission.submission_id });
      const flatEvals = batch.flatMap((c) => c.evaluations);
      const evalInserted =
        flatEvals.length === 0
          ? []
          : await tx
              .insert(evaluation)
              .values(
                flatEvals.map((e) => ({
                  evaluation_id: e.evaluation_id,
                  evaluation_group_id: e.evaluation_group_id,
                  submission_id: e.submission_id,
                  attempt: e.attempt,
                  status: e.status,
                  unit_results: e.unit_results,
                  aggregate: e.aggregate,
                  plan_digest: e.plan_digest,
                  run_refs: e.run_refs,
                  provenance: e.provenance,
                  created_at: e.created_at,
                })),
              )
              .onConflictDoNothing()
              .returning({ id: evaluation.evaluation_id });
      const headInserted = await tx
        .insert(evaluation_effective_head)
        .values(
          batch.map((c) => ({
            evaluation_group_id: c.head.evaluation_group_id,
            submission_id: c.head.submission_id,
            effective_evaluation_id: c.head.effective_evaluation_id,
            generation: c.head.generation,
            updated_at: c.head.updated_at,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: evaluation_effective_head.evaluation_group_id });

      const plannedRows = batch.length * 2 + batch.length + flatEvals.length + batch.length; // issuance+group+submission+eval+head
      const actualInserted =
        issuanceInserted.length +
        groupInserted.length +
        submissionInserted.length +
        evalInserted.length +
        headInserted.length;
      written += actualInserted;
      alreadyPresent += plannedRows - actualInserted;
    });

    // divergence 对账（批事务外读回）：submission 幂等键 + head 生效位必须同判。
    await assertSubmissionDivergence(db, batch);
  }
  return { written, alreadyPresent };
}

async function assertSubmissionDivergence(db: Db, batch: SubmissionChainPlan[]): Promise<void> {
  const submissionIds = batch.map((c) => c.submission.submission_id);
  const storedSubmissions = await db
    .select({
      submission_id: assessment_submission.submission_id,
      idempotency_key: assessment_submission.idempotency_key,
      evaluation_group_id: assessment_submission.evaluation_group_id,
    })
    .from(assessment_submission)
    .where(inArray(assessment_submission.submission_id, submissionIds));
  const plannedSubmissions = new Map(batch.map((c) => [c.submission.submission_id, c] as const));
  for (const stored of storedSubmissions) {
    const planned = plannedSubmissions.get(stored.submission_id);
    if (planned === undefined) continue;
    if (
      stored.idempotency_key !== planned.submission.idempotency_key ||
      stored.evaluation_group_id !== planned.submission.evaluation_group_id
    ) {
      throw new MigrationApplyError(
        `submission divergence @ ${stored.submission_id}：库内 idem=${stored.idempotency_key} group=${stored.evaluation_group_id} 与 plan 不符 —— 拒绝覆盖`,
      );
    }
  }
  const groupIds = batch.map((c) => c.head.evaluation_group_id);
  const storedHeads = await db
    .select({
      evaluation_group_id: evaluation_effective_head.evaluation_group_id,
      effective_evaluation_id: evaluation_effective_head.effective_evaluation_id,
      generation: evaluation_effective_head.generation,
      submission_id: evaluation_effective_head.submission_id,
    })
    .from(evaluation_effective_head)
    .where(inArray(evaluation_effective_head.evaluation_group_id, groupIds));
  const plannedHeads = new Map(batch.map((c) => [c.head.evaluation_group_id, c.head] as const));
  for (const stored of storedHeads) {
    const planned = plannedHeads.get(stored.evaluation_group_id);
    if (planned === undefined) continue;
    if (
      stored.effective_evaluation_id !== planned.effective_evaluation_id ||
      stored.generation !== planned.generation ||
      stored.submission_id !== planned.submission_id
    ) {
      throw new MigrationApplyError(
        `effective head divergence @ ${stored.evaluation_group_id}：库内 (effective=${String(stored.effective_evaluation_id)}, gen=${String(stored.generation)}) 与 plan (effective=${String(planned.effective_evaluation_id)}, gen=${String(planned.generation)}) 不符 —— 拒绝覆盖`,
      );
    }
  }
}

// ───────────────────────── reconcile ─────────────────────────

async function reconcile(
  db: Db,
  plan: MigrationApplyPlan,
  dryRun: boolean,
): Promise<ApplyReconciliationReport['reconciliation']> {
  const mappingRows = plan.records.flatMap((r) => (r.mapping !== null ? [r.mapping] : []));
  const chains = plan.records.flatMap((r) => (r.submission !== null ? [r.submission] : []));
  const empty = {
    mapping_rows_planned: mappingRows.length,
    mapping_rows_present: 0,
    mapping_rows_present_by_status: {} as Record<string, number>,
    issuances_planned: chains.length,
    issuances_present: 0,
    groups_planned: chains.length,
    groups_present: 0,
    submissions_planned: chains.length,
    submissions_present: 0,
    evaluations_planned: chains.reduce((acc, c) => acc + c.evaluations.length, 0),
    evaluations_present: 0,
    heads_planned: chains.length,
    heads_present: 0,
    divergences: [] as string[],
    learning_tables_touched: 'none (by construction)' as const,
  };
  if (dryRun) return empty;

  const mappingIds = mappingRows.map((m) => m.mapping_id);
  if (mappingIds.length > 0) {
    const present = await db
      .select({ status: assessment_identity_mapping.status })
      .from(assessment_identity_mapping)
      .where(inArray(assessment_identity_mapping.mapping_id, mappingIds));
    empty.mapping_rows_present = present.length;
    for (const row of present) {
      empty.mapping_rows_present_by_status[row.status] =
        (empty.mapping_rows_present_by_status[row.status] ?? 0) + 1;
    }
  }
  const idsPresent = async (
    table: 'issuance' | 'group' | 'submission' | 'head',
    ids: string[],
  ): Promise<number> => {
    if (ids.length === 0) return 0;
    switch (table) {
      case 'issuance': {
        const rows = await db
          .select({ id: assessment_issuance.issuance_id })
          .from(assessment_issuance)
          .where(inArray(assessment_issuance.issuance_id, ids));
        return rows.length;
      }
      case 'group': {
        const rows = await db
          .select({ id: evaluation_group.evaluation_group_id })
          .from(evaluation_group)
          .where(inArray(evaluation_group.evaluation_group_id, ids));
        return rows.length;
      }
      case 'submission': {
        const rows = await db
          .select({ id: assessment_submission.submission_id })
          .from(assessment_submission)
          .where(inArray(assessment_submission.submission_id, ids));
        return rows.length;
      }
      case 'head': {
        const rows = await db
          .select({ id: evaluation_effective_head.evaluation_group_id })
          .from(evaluation_effective_head)
          .where(inArray(evaluation_effective_head.evaluation_group_id, ids));
        return rows.length;
      }
    }
  };
  empty.issuances_present = await idsPresent(
    'issuance',
    chains.map((c) => c.issuance.issuance_id),
  );
  empty.groups_present = await idsPresent(
    'group',
    chains.map((c) => c.group.evaluation_group_id),
  );
  empty.submissions_present = await idsPresent(
    'submission',
    chains.map((c) => c.submission.submission_id),
  );
  empty.heads_present = await idsPresent(
    'head',
    chains.map((c) => c.head.evaluation_group_id),
  );
  const evalIds = chains.flatMap((c) => c.evaluations.map((e) => e.evaluation_id));
  if (evalIds.length > 0) {
    const rows = await db
      .select({ id: evaluation.evaluation_id })
      .from(evaluation)
      .where(inArray(evaluation.evaluation_id, evalIds));
    empty.evaluations_present = rows.length;
  }
  return empty;
}

// ───────────────────────── 主入口 ─────────────────────────

export interface MigrationApplyResult {
  runId: string;
  report: ApplyReconciliationReport;
}

/**
 * 分阶段执行 plan。幂等 + 可续跑：同 runId 重跑跳过 completed 阶段；
 * 未完成阶段靠内容寻址 id + ON CONFLICT DO NOTHING 收敛；任何 divergence
 * fail-visible（MigrationApplyError），绝不覆盖既有行。
 */
export async function runMigrationApply(args: MigrationApplyArgs): Promise<MigrationApplyResult> {
  const dryRun = args.dryRun ?? false;
  const batchSize = args.batchSize ?? 200;
  const now = args.now ?? (() => new Date());
  if (!dryRun && args.fence === null) {
    throw new MigrationApplyError(
      '非 dry-run 必须提供 advisory fence（专用连接实现）—— 拒绝无 fence 写库',
    );
  }

  const startedAt = now();
  const outcomes: PhaseOutcome[] = [];
  let runRow: LedgerRunRow | null = null;
  let fenceHeld = false;

  const finishRun = async (
    status: 'completed' | 'failed',
    error: string | null,
    walEnd: string | null,
  ): Promise<void> => {
    if (dryRun || runRow === null) return;
    await dbUpdateRun(args.db, runRow.run_id, status, now(), walEnd, error);
  };

  try {
    if (!dryRun) {
      const acquired = await args.fence?.acquire();
      if (!acquired) {
        throw new MigrationApplyError(
          'advisory fence 获取失败 —— 另一迁移执行器正在运行（单写者纪律）',
        );
      }
      fenceHeld = true;
    }

    runRow = await ensureRunRow(args.db, args.plan, args.runId, startedAt, dryRun);
    const priorPhases = dryRun ? new Map() : await phaseStatusOf(args.db, args.runId);
    if (runRow !== null && runRow.status === 'completed') {
      // 整 run 已完成 —— 幂等重放：不再写任何行，全部阶段报告为 skipped。
      const skippedOutcomes: PhaseOutcome[] = PHASE_ORDER.map((phase) => ({
        phase,
        status: 'skipped' as const,
        duration_ms: 0,
        rows_written: 0,
        rows_already_present: 0,
        wal_bytes: null,
        error: null,
      }));
      const report = await assembleReport(args, startedAt, skippedOutcomes);
      return { runId: args.runId, report };
    }

    for (const phase of PHASE_ORDER) {
      const phaseStart = now();
      const walStart = dryRun ? null : await currentWalLsn(args.db);
      const prior = priorPhases.get(phase);
      if (prior === 'completed') {
        outcomes.push({
          phase,
          status: 'skipped',
          duration_ms: 0,
          rows_written: 0,
          rows_already_present: 0,
          wal_bytes: null,
          error: null,
        });
        continue;
      }
      if (!dryRun) await startPhase(args.db, args.runId, phase, phaseStart, dryRun, walStart);
      let written = 0;
      let present = 0;
      try {
        switch (phase) {
          case 'preflight':
            await preflight(args.db, args.plan);
            break;
          case 'plan':
            // plan 已在调用方构建（纯函数）；此阶段落账 plan_digest 身份。
            break;
          case 'apply_mappings': {
            const result = await applyMappings(args.db, args.plan, batchSize, dryRun);
            written = result.written;
            present = result.alreadyPresent;
            break;
          }
          case 'apply_submissions': {
            const result = await applySubmissions(args.db, args.plan, batchSize, dryRun);
            written = result.written;
            present = result.alreadyPresent;
            break;
          }
          case 'reconcile':
            break;
        }
        const walEnd = dryRun ? null : await currentWalLsn(args.db);
        if (!dryRun) {
          await finishPhase(
            args.db,
            args.runId,
            phase,
            'completed',
            now(),
            now().getTime() - phaseStart.getTime(),
            written,
            present,
            dryRun,
            walEnd,
            null,
          );
        }
        outcomes.push({
          phase,
          status: 'completed',
          duration_ms: now().getTime() - phaseStart.getTime(),
          rows_written: written,
          rows_already_present: present,
          wal_bytes: walStart !== null && walEnd !== null ? walDeltaBytes(walStart, walEnd) : null,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const walEnd = dryRun ? null : await currentWalLsn(args.db).catch(() => null);
        if (!dryRun) {
          await finishPhase(
            args.db,
            args.runId,
            phase,
            'failed',
            now(),
            now().getTime() - phaseStart.getTime(),
            written,
            present,
            dryRun,
            walEnd,
            message,
          ).catch(() => undefined);
        }
        outcomes.push({
          phase,
          status: 'failed',
          duration_ms: now().getTime() - phaseStart.getTime(),
          rows_written: written,
          rows_already_present: present,
          wal_bytes: null,
          error: message,
        });
        throw error;
      }
    }

    const report = await assembleReport(args, startedAt, outcomes);
    await finishRun(
      'completed',
      null,
      dryRun ? null : await currentWalLsn(args.db).catch(() => null),
    );
    return { runId: args.runId, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun('failed', message, null).catch(() => undefined);
    throw error;
  } finally {
    if (fenceHeld) {
      await args.fence?.release().catch(() => undefined);
    }
  }
}

async function dbUpdateRun(
  db: Db,
  runId: string,
  status: 'completed' | 'failed',
  finishedAt: Date,
  walEnd: string | null,
  error: string | null,
): Promise<void> {
  await db
    .update(migration_apply_run)
    .set({ status, finished_at: finishedAt, wal_lsn_end: walEnd, error })
    .where(inArray(migration_apply_run.run_id, [runId]));
}

async function assembleReport(
  args: MigrationApplyArgs,
  startedAt: Date,
  outcomes: PhaseOutcome[],
): Promise<ApplyReconciliationReport> {
  const finishedAt = args.now?.() ?? new Date();
  const reconciliation = await reconcile(args.db, args.plan, args.dryRun ?? false);
  return {
    run_id: args.runId,
    checkpoint_hash: args.plan.checkpoint_hash,
    classification_hash: args.plan.classification_hash,
    classification_version: args.plan.classification_version,
    registry_digest: args.plan.registry_digest,
    plan_digest: planDigestOf(args.plan),
    algorithm_version: args.plan.algorithm_version,
    dry_run: args.dryRun ?? false,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    phases: outcomes,
    plan_totals: args.plan.rollup.totals,
    mapping_status_plan: args.plan.rollup.mapping_status,
    reconciliation,
    worklists: {
      unresolved: args.plan.worklists.unresolved.length,
      deferred_replay: args.plan.worklists.deferred_replay.length,
      awaiting_revision_registry: args.plan.worklists.awaiting_revision_registry.length,
      conflicted: args.plan.worklists.conflicted.length,
    },
  };
}

/** 报告工件文件名（内容寻址：run id）。 */
export function applyReportFileName(runId: string): string {
  return `apply-report-${runId}.json`;
}

/** reconciliation 断言：plan 与库内完全一致（缺失/多余都 fail-visible）。 */
export function assertReconciliationClean(report: ApplyReconciliationReport): void {
  const r = report.reconciliation;
  const problems: string[] = [];
  if (r.mapping_rows_planned !== r.mapping_rows_present) {
    problems.push(
      `mapping rows planned=${r.mapping_rows_planned} present=${r.mapping_rows_present}`,
    );
  }
  if (r.issuances_planned !== r.issuances_present) {
    problems.push(`issuances planned=${r.issuances_planned} present=${r.issuances_present}`);
  }
  if (r.groups_planned !== r.groups_present) {
    problems.push(`groups planned=${r.groups_planned} present=${r.groups_present}`);
  }
  if (r.submissions_planned !== r.submissions_present) {
    problems.push(`submissions planned=${r.submissions_planned} present=${r.submissions_present}`);
  }
  if (r.evaluations_planned !== r.evaluations_present) {
    problems.push(`evaluations planned=${r.evaluations_planned} present=${r.evaluations_present}`);
  }
  if (r.heads_planned !== r.heads_present) {
    problems.push(`heads planned=${r.heads_planned} present=${r.heads_present}`);
  }
  if (r.divergences.length > 0) problems.push(...r.divergences);
  if (problems.length > 0) {
    throw new MigrationApplyError(`reconciliation 不洁：${problems.join('; ')}`);
  }
}
