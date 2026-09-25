import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  type MigrationApplyPlan,
  type SubmissionChainPlan,
  mappingRowDigest,
  planDigestOf,
} from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
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
// YUK-1050 — 历史迁移 apply · DB 执行器（grounding §15；review P1-1..P1-5 修订）
// ====================================================================
//
// 消费纯规划器（core/migration/apply.ts）的 MigrationApplyPlan，分阶段幂等
// 落库：preflight → plan → apply_mappings → apply_submissions → reconcile。
//
// 纪律：
//   - 单写者 fence：advisory lock（跨阶段持有；由调用方提供专用连接实现，
//     池化连接上的 session lock 会在连接归还时释放，不能作 fence）。
//   - 幂等：一切主键内容寻址派生 + INSERT ... ON CONFLICT DO NOTHING；
//     已存在的行做【完整内容】对账（P1-3：digest 覆盖全部不可变载荷，
//     divergence fail-visible，绝不覆盖 —— guarded 表的 UPDATE/DELETE 由
//     0105/0106/0107 trigger 拒绝，这里也不尝试）。
//   - pending→resolved 续跑（P1-5）：registry 后到的 mapped 裁决对【本工具
//     早前写入的 pending 当前映射】走显式 supersession —— 旧行 is_current=false
//     （status/evidence 原样保留），新行 is_current=true 并链
//     supersedes_mapping_id。其余任何状态迁移（mapped↔conflicted、改判目标）
//     一律 divergence fail-visible，属显式修正工作流。
//   - crash 续跑：阶段进度入账本（migration_apply_run/phase）；重跑跳过
//     completed 阶段，未完成阶段靠幂等收敛。reconcile 在标记 completed【之前】
//     做全内容对账（P1-3：断言失败 ⇒ run=failed，绝不先记账后失败）。
//   - 观测：每阶段 duration、rows_written/already_present、WAL LSN 位移
//     （权限不足时为 null —— 不冒装）。
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

export interface HeadCurrentState {
  evaluation_group_id: string;
  effective_evaluation_id: string | null;
  generation: number;
  post_migration_activation: boolean;
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
    mapping_rows_superseded_in_run: number;
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
    heads_current: HeadCurrentState[];
    divergences: string[];
    learning_tables_touched: 'none (by construction)';
  };
  worklists: {
    unresolved: number;
    deferred_replay: number;
    awaiting_revision_registry: number;
    conflicted: number;
    live_drafts: number;
    reconstruction_blocked: number;
  };
}

export class MigrationApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationApplyError';
  }
}

// ───────────────────────── 观测原语 ─────────────────────────

async function currentWalLsn(db: Db | { execute: Db['execute'] }): Promise<string | null> {
  try {
    const result = (await db.execute(sql`select pg_current_wal_lsn()::text as lsn`)) as unknown;
    // postgres-js drizzle：execute 直接返回行数组（非 {rows} 信封）—— 两种形态
    // 都容错，权限不足抛错时降级 null（不冒装观测）。
    const rows = Array.isArray(result)
      ? (result as Array<{ lsn: string | null }>)
      : ((result as { rows?: Array<{ lsn: string | null }> }).rows ?? []);
    return rows[0]?.lsn ?? null;
  } catch {
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
  const walStart = await currentWalLsn(db);
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
      wal_lsn_start: walStart,
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

// ───────────────────────── 存储行内容对账（P1-3） ─────────────────────────

type MappingStoredRow = {
  mapping_id: string;
  source_kind: string;
  source_id: string;
  source_locator: string;
  original_question_id: string;
  legacy_part_ref: string | null;
  snapshot_digest: string | null;
  target_revision_id: string | null;
  target_part_id: string | null;
  target_slot_id: string | null;
  evidence: unknown;
  algorithm_version: string;
  status: string;
  is_current: boolean;
  created_at: Date;
};

function mappingContentDigest(
  row: Omit<MappingStoredRow, 'mapping_id' | 'is_current' | 'created_at'> & {
    created_at?: unknown;
  },
): string {
  return canonicalHash({
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_locator: row.source_locator,
    original_question_id: row.original_question_id,
    legacy_part_ref: row.legacy_part_ref,
    snapshot_digest: row.snapshot_digest,
    target_revision_id: row.target_revision_id,
    target_part_id: row.target_part_id,
    target_slot_id: row.target_slot_id,
    evidence: row.evidence,
    algorithm_version: row.algorithm_version,
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  });
}

function plannedMappingContentDigest(
  planned: NonNullable<MigrationApplyPlan['records'][number]['mapping']>,
): string {
  // mappingRowDigest 覆盖同一字段面（supersedes_mapping_id 是过渡簿记，不参与
  // 内容对账）。
  return mappingRowDigest(planned);
}

// ───────────────────────── apply_mappings ─────────────────────────

interface MappingWriteStats {
  written: number;
  alreadyPresent: number;
  superseded: number;
}

async function applyMappings(
  db: Db,
  plan: MigrationApplyPlan,
  batchSize: number,
  dryRun: boolean,
): Promise<MappingWriteStats> {
  const rows = plan.records.flatMap((r) =>
    r.mapping !== null ? [{ record: r.classification, mapping: r.mapping }] : [],
  );
  const stats: MappingWriteStats = { written: 0, alreadyPresent: 0, superseded: 0 };
  if (rows.length === 0 || dryRun) return stats;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const locatorToPlanned = new Map(
      batch.map((b) => [b.mapping.source_locator, b.mapping] as const),
    );
    const result = await db.transaction(async (tx) => {
      // 同 locator 的当前行（含 pending→resolved 接替判断）+ 非当前行（历史链）。
      const stored = (await tx
        .select()
        .from(assessment_identity_mapping)
        .where(
          inArray(assessment_identity_mapping.source_locator, [...locatorToPlanned.keys()]),
        )) as unknown as MappingStoredRow[];
      const currentByLocator = new Map<string, MappingStoredRow>();
      for (const row of stored) {
        if (row.is_current) currentByLocator.set(row.source_locator, row);
      }
      // 插入对象就地构造（不走 helper）—— audit:schema 的词法写路径检测需要
      // 字段键出现在 insert 语句载荷内。
      const toInsert: Array<{
        planned: (typeof batch)[number]['mapping'];
        supersedes: string | null;
      }> = [];
      for (const planned of batch.map((b) => b.mapping)) {
        const existing = currentByLocator.get(planned.source_locator);
        if (existing === undefined) {
          toInsert.push({ planned, supersedes: null });
          continue;
        }
        if (mappingContentDigest(existing) === plannedMappingContentDigest(planned)) {
          stats.alreadyPresent += 1; // 逐字节同判 —— 幂等跳过
          continue;
        }
        // P1-5：pending 是【未裁决】的操作性占位 —— 本工具可对自写的 pending 行
        // 显式接替（registry 后到的 mapped/conflicted 裁决，或同裁决的 reason
        // 刷新）；已裁决行（mapped/conflicted/historical）的任何内容迁移一律
        // fail-visible，属显式修正工作流。
        const authoredByThisTool = planned.algorithm_version.startsWith('yuk1050-apply');
        const existingAuthoredByThisTool = existing.algorithm_version.startsWith('yuk1050-apply');
        const supersedeOk =
          existing.status === 'pending' && authoredByThisTool && existingAuthoredByThisTool;
        if (supersedeOk) {
          if (planned.status === 'pending') {
            // pending→pending：仅允许【操作性注释】刷新（reason/evidence 文案）。
            // 裁决字段（status/targets/snapshot_digest）必须逐字一致 —— 否则不是
            // 注释刷新而是裁决变化，必须走 supersede/divergence，绝不原地覆盖。
            const adjudicationIdentical =
              existing.status === planned.status &&
              existing.target_revision_id === planned.target_revision_id &&
              existing.target_part_id === planned.target_part_id &&
              existing.target_slot_id === planned.target_slot_id &&
              existing.snapshot_digest === planned.snapshot_digest &&
              existing.legacy_part_ref === planned.legacy_part_ref &&
              existing.original_question_id === planned.original_question_id;
            if (!adjudicationIdentical) {
              throw new MigrationApplyError(
                `mapping divergence @ ${planned.source_locator}：pending 行的裁决字段与 plan 不一致（原地刷新只允许操作性注释变化；裁决变化走显式接替）`,
              );
            }
            await tx
              .update(assessment_identity_mapping)
              .set({
                evidence: planned.evidence,
                algorithm_version: planned.algorithm_version,
              })
              .where(eq(assessment_identity_mapping.mapping_id, existing.mapping_id));
            stats.alreadyPresent += 1;
          } else {
            // pending→mapped/conflicted：新裁决新行（mapping_id 含裁决内容），
            // 旧行 is_current=false + supersedes 链（裁决历史原样保留）。
            await tx
              .update(assessment_identity_mapping)
              .set({ is_current: false })
              .where(eq(assessment_identity_mapping.mapping_id, existing.mapping_id));
            toInsert.push({ planned, supersedes: existing.mapping_id });
            stats.superseded += 1;
          }
          continue;
        }
        throw new MigrationApplyError(
          `mapping divergence @ ${planned.source_locator}：库内当前行 (status=${existing.status}, target=${String(existing.target_revision_id)}, digest=${String(existing.snapshot_digest)}) 与 plan (status=${planned.status}, target=${String(planned.target_revision_id)}) 内容不符 —— 拒绝覆盖；除本工具 pending→resolved 接替外，改判属显式修正工作流`,
        );
      }
      if (toInsert.length > 0) {
        const inserted = await tx
          .insert(assessment_identity_mapping)
          .values(
            toInsert.map((entry) => ({
              mapping_id: entry.planned.mapping_id,
              source_kind: entry.planned.source_kind,
              source_id: entry.planned.source_id,
              source_locator: entry.planned.source_locator,
              original_question_id: entry.planned.original_question_id,
              legacy_part_ref: entry.planned.legacy_part_ref,
              snapshot_digest: entry.planned.snapshot_digest,
              target_revision_id: entry.planned.target_revision_id,
              target_part_id: entry.planned.target_part_id,
              target_slot_id: entry.planned.target_slot_id,
              evidence: entry.planned.evidence,
              algorithm_version: entry.planned.algorithm_version,
              status: entry.planned.status,
              is_current: true,
              supersedes_mapping_id: entry.supersedes,
              created_at: entry.planned.created_at,
            })),
          )
          // 冲突裁决交给任意 unique violation（arbiter-less）：本表在 (source_kind,
          // source_id, source_locator) 上的唯一索引是【部分索引】（WHERE
          // is_current），当前 drizzle 版本不支持 conflict target 的 index
          // predicate —— 而内容寻址 mapping_id 与 locator 裁决一一对应，PK 冲突
          // 与当前映射唯一索引语义重合。
          .onConflictDoNothing()
          .returning({ mapping_id: assessment_identity_mapping.mapping_id });
        stats.written += inserted.length;
        if (inserted.length !== toInsert.length) {
          throw new MigrationApplyError(
            'mapping insert 冲突但当前行对账未命中 —— 账本/表状态不一致，fail-visible',
          );
        }
      }
      return true;
    });
    void result;
  }
  return stats;
}

// ───────────────────────── apply_submissions ─────────────────────────

interface SubmissionWriteStats {
  written: number;
  alreadyPresent: number;
}

async function applySubmissions(
  db: Db,
  plan: MigrationApplyPlan,
  batchSize: number,
  dryRun: boolean,
): Promise<SubmissionWriteStats> {
  const chains = plan.records.flatMap((r) => (r.submission !== null ? [r.submission] : []));
  const stats: SubmissionWriteStats = { written: 0, alreadyPresent: 0 };
  if (chains.length === 0 || dryRun) return stats;
  for (let i = 0; i < chains.length; i += batchSize) {
    const batch = chains.slice(i, i + batchSize);
    // FK 拓扑序（0105/0106 非 DEFERRABLE）：issuance/group → submission →
    // evaluation → head；单批单事务，崩即整批回滚（幂等重放收敛）。
    // 冲突行的【完整内容】对账在同一事务内完成（P1-3：先验证后提交）。
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

      const plannedRows = batch.length * 4 + flatEvals.length; // issuance+group+submission+head+eval
      const actualInserted =
        issuanceInserted.length +
        groupInserted.length +
        submissionInserted.length +
        evalInserted.length +
        headInserted.length;
      stats.written += actualInserted;
      stats.alreadyPresent += plannedRows - actualInserted;

      // 全内容对账（同事务内，先验证后提交）。
      await assertSubmissionBatchContent(tx, batch);
    });
  }
  return stats;
}

/** 事务内读回冲突行，比对【完整不可变载荷】；head 是可变行，走显式推进规则。
 * ──── P1-1（终轮）：共享的全内容比较器 ────
 * 批事务断言与最终/已完成-run 对账复用同一套【完整载荷】比较 —— 任何一处存储
 * 内容与 plan 不符都产生 divergence 描述（批内立即抛，reconcile 汇入报告）。 */

type ChainTx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface StoredIssuance {
  issuance_id: string;
  revision_id: string;
  part_ids: unknown;
  material_bindings: unknown;
  option_order: unknown;
  container_occurrence_ref: string | null;
  claim_policy: string;
  issued_at: Date;
}
interface StoredGroup {
  evaluation_group_id: string;
  submission_ids: unknown;
  created_at: Date;
}
interface StoredSubmission {
  submission_id: string;
  issuance_id: string;
  revision_id: string;
  evaluation_group_id: string;
  response_set: unknown;
  group_evidence: unknown;
  idempotency_key: string;
  submitted_at: Date;
}
interface StoredEvaluation {
  evaluation_id: string;
  evaluation_group_id: string;
  submission_id: string;
  attempt: number;
  status: string;
  unit_results: unknown;
  aggregate: unknown;
  plan_digest: string | null;
  run_refs: unknown;
  provenance: unknown;
  created_at: Date;
}
interface StoredHead {
  evaluation_group_id: string;
  submission_id: string;
  effective_evaluation_id: string | null;
  generation: number;
}

interface ChainRowSnapshot {
  issuances: Map<string, StoredIssuance>;
  groups: Map<string, StoredGroup>;
  submissions: Map<string, StoredSubmission>;
  evaluations: Map<string, StoredEvaluation>;
  heads: Map<string, StoredHead>;
}

async function readChainRows(
  dbOrTx: Db | ChainTx,
  chains: readonly SubmissionChainPlan[],
): Promise<ChainRowSnapshot> {
  const db = dbOrTx as Db;
  const issuanceRows = chains.length
    ? ((await db
        .select()
        .from(assessment_issuance)
        .where(
          inArray(
            assessment_issuance.issuance_id,
            chains.map((c) => c.issuance.issuance_id),
          ),
        )) as unknown as StoredIssuance[])
    : [];
  const groupRows = chains.length
    ? ((await db
        .select()
        .from(evaluation_group)
        .where(
          inArray(
            evaluation_group.evaluation_group_id,
            chains.map((c) => c.group.evaluation_group_id),
          ),
        )) as unknown as StoredGroup[])
    : [];
  const submissionRows = chains.length
    ? ((await db
        .select()
        .from(assessment_submission)
        .where(
          inArray(
            assessment_submission.submission_id,
            chains.map((c) => c.submission.submission_id),
          ),
        )) as unknown as StoredSubmission[])
    : [];
  const evalRows = chains.length
    ? ((await db
        .select()
        .from(evaluation)
        .where(
          inArray(
            evaluation.evaluation_id,
            chains.flatMap((c) => c.evaluations.map((e) => e.evaluation_id)),
          ),
        )) as unknown as StoredEvaluation[])
    : [];
  const headRows = chains.length
    ? ((await db
        .select()
        .from(evaluation_effective_head)
        .where(
          inArray(
            evaluation_effective_head.evaluation_group_id,
            chains.map((c) => c.head.evaluation_group_id),
          ),
        )) as unknown as StoredHead[])
    : [];
  return {
    issuances: new Map(issuanceRows.map((r) => [r.issuance_id, r] as const)),
    groups: new Map(groupRows.map((r) => [r.evaluation_group_id, r] as const)),
    submissions: new Map(submissionRows.map((r) => [r.submission_id, r] as const)),
    evaluations: new Map(evalRows.map((r) => [r.evaluation_id, r] as const)),
    heads: new Map(headRows.map((r) => [r.evaluation_group_id, r] as const)),
  };
}

/**
 * 全内容比较（不可变载荷逐字段 digest；issuance 只比冻结绑定列 —— claim 生命
 * 周期列 0105 允许 runtime 变更；head 是可变行，走显式推进规则）。返回
 * divergence 描述列表（空 = 一致）。
 */
function compareChains(chains: readonly SubmissionChainPlan[], stored: ChainRowSnapshot): string[] {
  const divergences: string[] = [];
  for (const chain of chains) {
    const issuance = stored.issuances.get(chain.issuance.issuance_id);
    if (issuance !== undefined) {
      const storedBinding = canonicalHash({
        revision_id: issuance.revision_id,
        part_ids: issuance.part_ids,
        material_bindings: issuance.material_bindings,
        option_order: issuance.option_order,
        container_occurrence_ref: issuance.container_occurrence_ref,
        claim_policy: issuance.claim_policy,
        issued_at:
          issuance.issued_at instanceof Date
            ? issuance.issued_at.toISOString()
            : issuance.issued_at,
      });
      const plannedBinding = canonicalHash({
        revision_id: chain.issuance.revision_id,
        part_ids: chain.issuance.part_ids,
        material_bindings: chain.issuance.material_bindings,
        option_order: chain.issuance.option_order,
        container_occurrence_ref: chain.issuance.container_occurrence_ref,
        claim_policy: chain.issuance.claim_policy,
        issued_at: chain.issuance.issued_at.toISOString(),
      });
      if (storedBinding !== plannedBinding) {
        divergences.push(`issuance @ ${chain.issuance.issuance_id}：冻结绑定列与 plan 不符`);
      }
    }
    const group = stored.groups.get(chain.group.evaluation_group_id);
    if (group !== undefined) {
      const storedContent = canonicalHash({
        submission_ids: group.submission_ids,
        created_at:
          group.created_at instanceof Date ? group.created_at.toISOString() : group.created_at,
      });
      const plannedContent = canonicalHash({
        submission_ids: chain.group.submission_ids,
        created_at: chain.group.created_at.toISOString(),
      });
      if (storedContent !== plannedContent) {
        divergences.push(
          `evaluation group @ ${chain.group.evaluation_group_id}：成员/时间与 plan 不符`,
        );
      }
    }
    const submission = stored.submissions.get(chain.submission.submission_id);
    if (submission !== undefined) {
      const storedContent = canonicalHash({
        issuance_id: submission.issuance_id,
        revision_id: submission.revision_id,
        evaluation_group_id: submission.evaluation_group_id,
        response_set: submission.response_set,
        group_evidence: submission.group_evidence,
        idempotency_key: submission.idempotency_key,
        submitted_at:
          submission.submitted_at instanceof Date
            ? submission.submitted_at.toISOString()
            : submission.submitted_at,
      });
      const plannedContent = canonicalHash({
        issuance_id: chain.submission.issuance_id,
        revision_id: chain.submission.revision_id,
        evaluation_group_id: chain.submission.evaluation_group_id,
        response_set: chain.submission.response_set,
        group_evidence: chain.submission.group_evidence,
        idempotency_key: chain.submission.idempotency_key,
        submitted_at: chain.submission.submitted_at.toISOString(),
      });
      if (storedContent !== plannedContent) {
        divergences.push(
          `submission @ ${chain.submission.submission_id}：冻结作答内容与 plan 不符`,
        );
      }
    }
    for (const plannedEval of chain.evaluations) {
      const evaluationRow = stored.evaluations.get(plannedEval.evaluation_id);
      if (evaluationRow === undefined) continue;
      const storedContent = canonicalHash({
        evaluation_group_id: evaluationRow.evaluation_group_id,
        submission_id: evaluationRow.submission_id,
        attempt: evaluationRow.attempt,
        status: evaluationRow.status,
        unit_results: evaluationRow.unit_results,
        aggregate: evaluationRow.aggregate,
        plan_digest: evaluationRow.plan_digest,
        run_refs: evaluationRow.run_refs,
        provenance: evaluationRow.provenance,
        created_at:
          evaluationRow.created_at instanceof Date
            ? evaluationRow.created_at.toISOString()
            : evaluationRow.created_at,
      });
      const plannedContent = canonicalHash({
        evaluation_group_id: plannedEval.evaluation_group_id,
        submission_id: plannedEval.submission_id,
        attempt: plannedEval.attempt,
        status: plannedEval.status,
        unit_results: plannedEval.unit_results,
        aggregate: plannedEval.aggregate,
        plan_digest: plannedEval.plan_digest,
        run_refs: plannedEval.run_refs,
        provenance: plannedEval.provenance,
        created_at: plannedEval.created_at.toISOString(),
      });
      if (storedContent !== plannedContent) {
        divergences.push(`evaluation @ ${plannedEval.evaluation_id}：判分记录内容与 plan 不符`);
      }
    }
    const head = stored.heads.get(chain.head.evaluation_group_id);
    if (head !== undefined && !headStateAccepted(head, chain.head)) {
      divergences.push(
        `effective head @ ${chain.head.evaluation_group_id}：库内 (effective=${String(head.effective_evaluation_id)}, gen=${String(head.generation)}) 与 plan (effective=${String(chain.head.effective_evaluation_id)}, gen=${String(chain.head.generation)}) 不符且非合法推进`,
      );
    }
  }
  return divergences;
}

/** 批事务内断言：先读后比，任何 divergence 在提交前抛出。 */
async function assertSubmissionBatchContent(
  tx: ChainTx,
  batch: readonly SubmissionChainPlan[],
): Promise<void> {
  const divergences = compareChains(batch, await readChainRows(tx, batch));
  if (divergences.length > 0) {
    throw new MigrationApplyError(`批内容对账失败（提交前拒绝）：${divergences.join('; ')}`);
  }
}

/**
 * head 是【可变行】（runtime activation 推进 generation）：迁移写入的是导入
 * 终态（legacy effective ⇒ effective 指向导入 evaluation、gen=1；否则 null/0）。
 * 库内状态合法当且仅当：submission 坐标一致，且 (a) 与 plan 相同，或
 * (b) generation 更高 —— 迁移后被 settlement/runtime 激活/替换（合法演进）。
 */
function headStateAccepted(
  stored: { submission_id: string; effective_evaluation_id: string | null; generation: number },
  planned: { submission_id: string; effective_evaluation_id: string | null; generation: number },
): boolean {
  if (stored.submission_id !== planned.submission_id) return false;
  if (
    stored.generation === planned.generation &&
    stored.effective_evaluation_id === planned.effective_evaluation_id
  ) {
    return true;
  }
  return stored.generation > planned.generation;
}

// ───────────────────────── reconcile（P1-3：全内容对账） ─────────────────────────

async function reconcile(
  db: Db,
  plan: MigrationApplyPlan,
  dryRun: boolean,
): Promise<ApplyReconciliationReport['reconciliation']> {
  const mappingRows = plan.records.flatMap((r) => (r.mapping !== null ? [r.mapping] : []));
  const chains = plan.records.flatMap((r) => (r.submission !== null ? [r.submission] : []));
  const out: ApplyReconciliationReport['reconciliation'] = {
    mapping_rows_planned: mappingRows.length,
    mapping_rows_present: 0,
    mapping_rows_present_by_status: {},
    mapping_rows_superseded_in_run: 0,
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
    heads_current: [],
    divergences: [],
    learning_tables_touched: 'none (by construction)',
  };
  if (dryRun) return out;

  // 映射行：存在性 + 【全内容】对账（P1-1 终轮：不是只数 ID）。
  if (mappingRows.length > 0) {
    const stored = (await db
      .select()
      .from(assessment_identity_mapping)
      .where(
        inArray(
          assessment_identity_mapping.mapping_id,
          mappingRows.map((m) => m.mapping_id),
        ),
      )) as unknown as MappingStoredRow[];
    const plannedById = new Map(mappingRows.map((m) => [m.mapping_id, m] as const));
    for (const row of stored) {
      out.mapping_rows_present += 1;
      out.mapping_rows_present_by_status[row.status] =
        (out.mapping_rows_present_by_status[row.status] ?? 0) + 1;
      const planned = plannedById.get(row.mapping_id);
      if (planned === undefined) continue;
      if (!row.is_current || mappingContentDigest(row) !== plannedMappingContentDigest(planned)) {
        out.divergences.push(
          `mapping @ ${row.source_locator}：库内当前行内容与 plan 不符（is_current=${String(row.is_current)}）`,
        );
      }
    }
  }
  const supersededCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assessment_identity_mapping)
    .where(
      and(
        eq(assessment_identity_mapping.is_current, false),
        sql`${assessment_identity_mapping.algorithm_version} like 'yuk1050-apply/%'`,
      ),
    );
  out.mapping_rows_superseded_in_run = supersededCount[0]?.count ?? 0;

  // submission 链：读回全部存储行，走与批事务断言【同一套】全内容比较器
  // （P1-1 终轮：最终对账与已完成-run 重放都覆盖完整载荷，绝非只比 ID）。
  const storedChains = await readChainRows(db, chains);
  out.divergences.push(...compareChains(chains, storedChains));
  out.issuances_present = chains.filter((c) =>
    storedChains.issuances.has(c.issuance.issuance_id),
  ).length;
  out.groups_present = chains.filter((c) =>
    storedChains.groups.has(c.group.evaluation_group_id),
  ).length;
  out.submissions_present = chains.filter((c) =>
    storedChains.submissions.has(c.submission.submission_id),
  ).length;
  out.evaluations_present = chains.reduce(
    (acc, c) =>
      acc + c.evaluations.filter((e) => storedChains.evaluations.has(e.evaluation_id)).length,
    0,
  );
  for (const chain of chains) {
    const head = storedChains.heads.get(chain.head.evaluation_group_id);
    if (head === undefined) continue;
    out.heads_present += 1;
    out.heads_current.push({
      evaluation_group_id: head.evaluation_group_id,
      effective_evaluation_id: head.effective_evaluation_id,
      generation: head.generation,
      post_migration_activation: head.generation > chain.head.generation,
    });
  }
  return out;
}

// ───────────────────────── 主入口 ─────────────────────────

export interface MigrationApplyResult {
  runId: string;
  report: ApplyReconciliationReport;
}

/**
 * 分阶段执行 plan。幂等 + 可续跑：同 runId 重跑跳过 completed 阶段；
 * 未完成阶段靠内容寻址 id + ON CONFLICT DO NOTHING 收敛；任何 divergence
 * fail-visible（MigrationApplyError），绝不覆盖既有行。run 标记 completed
 * 【之前】必须通过全内容 reconciliation 断言（P1-3）。
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
    await args.db
      .update(migration_apply_run)
      .set({ status, finished_at: now(), wal_lsn_end: walEnd, error })
      .where(inArray(migration_apply_run.run_id, [runRow.run_id]));
  };

  try {
    if (!dryRun) {
      const acquired = await args.fence?.acquire();
      if (acquired !== true) {
        throw new MigrationApplyError(
          'advisory fence 获取失败 —— 另一迁移执行器正在运行（单写者纪律）',
        );
      }
      fenceHeld = true;
    }

    runRow = await ensureRunRow(args.db, args.plan, args.runId, startedAt, dryRun);
    const priorPhases = dryRun ? new Map() : await phaseStatusOf(args.db, args.runId);
    if (runRow !== null && runRow.status === 'completed') {
      // 整 run 已完成 —— 幂等重放：不再写任何行；仍做全内容对账（head 推进等
      // 迁移后合法演进在此显形），断言失败则报 divergence（不静默）。
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
      assertReconciliationClean(report); // 已完成 run 的重放仍做全内容对账
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

    // P1-3：先全内容对账断言，后标记 completed —— 断言失败 ⇒ run=failed。
    // dry-run 零写入，presence 恒为 0 —— 跳过断言（report 仍产出对账面）。
    const report = await assembleReport(args, startedAt, outcomes);
    if (!dryRun) assertReconciliationClean(report);
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

async function assembleReport(
  args: MigrationApplyArgs,
  startedAt: Date,
  outcomes: PhaseOutcome[],
): Promise<ApplyReconciliationReport> {
  const finishedAt = args.now?.() ?? new Date();
  const reconciliation = await reconcile(args.db, args.plan, args.dryRun ?? false);
  const work = args.plan.worklists;
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
      unresolved: work.unresolved.length,
      deferred_replay: work.deferred_replay.length,
      awaiting_revision_registry: work.awaiting_revision_registry.length,
      conflicted: work.conflicted.length,
      live_drafts: work.live_drafts.length,
      reconstruction_blocked: work.reconstruction_blocked.length,
    },
  };
}

/** 报告工件文件名（内容寻址：run id）。 */
export function applyReportFileName(runId: string): string {
  return `apply-report-${runId}.json`;
}

/** reconciliation 断言：plan 与库内逐表一致（数量 + 内容 divergences 为空）。 */
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
