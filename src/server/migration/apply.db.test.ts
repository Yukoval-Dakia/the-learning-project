import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BuildApplyPlanInput,
  type RevisionRegistry,
  type RevisionRegistryEntry,
  buildMigrationApplyPlan,
  parseRevisionRegistry,
} from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import type { MigrationCapture } from '@/core/migration/types';
import type { Db } from '@/db/client';

import {
  assessment_identity_mapping,
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  material_fsrs_state,
  migration_apply_phase,
  migration_apply_run,
  question_revision,
  source_asset,
} from '@/db/schema';
import { loadRevisionContracts } from '../../../scripts/migration-apply';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  MigrationApplyError,
  type MigrationApplyFence,
  assertReconciliationClean,
  runMigrationApply,
} from './apply';
import { captureMigrationCheckpoint } from './capture';

// YUK-1050（review 修订版）— apply 执行器 DB 测试：真表 seed（corpus
// question_revision + legacy attempt/judge/review/pending/draft/asset）→
// 真实 capture reader → 分类 → 规划 → 分阶段执行。钉住：幂等重跑零重复、
// crash 中断后续跑收敛、pending→resolved supersession 续跑、divergence
// fail-visible、fence 纪律、guarded 表 INSERT-only（DB trigger）、head 为
// non-effective 初态且迁移后激活被识别为合法演进、学习状态表零触碰。

const NOW = new Date('2026-09-20T00:00:00.000Z');

const ATTEMPT_SNAPSHOT = {
  schema_version: 1,
  question: {
    question_id: 'q-main',
    question_version: 0,
    parent_question_id: null,
    prompt_md: '1+1=?',
    reference_md: '2',
    choices_md: null,
    image_refs: [],
    figures: [],
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  parent_question: null,
} as const;

const FROZEN_DURABLE = {
  kind: 'short_answer',
  prompt_md: '1+1=?',
  reference_md: '2',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['kc-1'],
  difficulty: 3,
  metadata: null,
  figures: [],
  image_refs: [],
  structured: null,
  version: 0,
  updated_at: '2026-09-01T00:00:00.000Z',
} as const;

const FENCE: MigrationApplyFence = { acquire: async () => true, release: async () => undefined };
const NO_FENCE: MigrationApplyFence = {
  acquire: async () => false,
  release: async () => undefined,
};

function revisionRow(revisionId: string, groupId: string): typeof question_revision.$inferInsert {
  return {
    revision_id: revisionId,
    group_id: groupId,
    revision_ordinal: 1,
    integrity_digest: canonicalHash({ revision: revisionId }),
    structure: {
      group_id: groupId,
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '1+1=?', material_ids: [] }],
    },
    response_spec: {
      slots: [
        {
          slot_id: 's1',
          part_id: 'p1',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'legacy-import',
            statement_md: 'historical import',
            source: 'manual',
          },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [{ scoring_unit_ids: ['u1'], executor: { kind: 'human_review' } }],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    supersedes_revision_id: null,
    availability: 'general_pool' as const,
    published_by: { by: 'system' as const, task_kind: 'migration-corpus-import' },
    published_at: NOW,
  };
}

function registryEntry(
  questionId: string,
  revisionId: string,
  snapshotDigest: string,
): RevisionRegistryEntry {
  return {
    question_id: questionId,
    revision_id: revisionId,
    part_ids: ['p1'],
    slot_id: 's1',
    scoring_unit_id: 'u1',
    binding_kind: 'snapshot_verified',
    snapshot_digest: snapshotDigest,
    assertion_reason: null,
    published_at: NOW.toISOString(),
  };
}

async function seedEvent(
  row: Partial<typeof event.$inferInsert> &
    Pick<typeof event.$inferInsert, 'id' | 'action' | 'subject_kind' | 'subject_id' | 'payload'>,
): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      task_run_id: null,
      cost_micro_usd: null,
      caused_by_event_id: null,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      outcome: null,
      created_at: NOW,
      ...row,
    });
}

/** 代表性历史语料：complete attempt 链 + durable 回填 review + pending/draft/lineage + 图片资产。 */
async function seedLegacyHistory(): Promise<void> {
  // corpus 导入产物（YUK-1043 lane 的接缝工件在 apply 侧以 registry 表达）。
  await testDb()
    .insert(question_revision)
    .values([
      revisionRow('rev-q-main', 'grp-q-main'),
      revisionRow('rev-q-durable', 'grp-q-durable'),
    ]);

  // 1) complete attempt 链：attempt（带冻结 snapshot + 图片证据）+ head judge verdict。
  await seedEvent({
    id: 'att-1',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q-main',
    outcome: 'failure',
    payload: {
      answer_md: '3',
      answer_image_refs: ['asset-1'],
      referenced_knowledge_ids: ['kc-1'],
      question_snapshot: ATTEMPT_SNAPSHOT,
    },
  });
  await testDb()
    .insert(source_asset)
    .values({
      id: 'asset-1',
      kind: 'image',
      storage_key: 'answers/asset-1.png',
      mime_type: 'image/png',
      byte_size: 2048,
      sha256: 'b'.repeat(64),
      created_at: NOW,
    });
  await seedEvent({
    id: 'jud-1',
    actor_kind: 'agent',
    actor_ref: 'judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'att-1',
    outcome: 'success',
    payload: { coarse_outcome: 'incorrect', score: 0, feedback_md: '应为 2' },
    created_at: new Date('2026-09-20T00:00:05.000Z'),
  });

  // 2) durable 回填 review：pending（run_id=review id，带冻结 snapshot）+ review（embedded verdict）。
  await seedEvent({
    id: 'run-d1',
    action: 'experimental:judge_pending_attempt',
    subject_kind: 'question',
    subject_id: 'q-durable',
    payload: {
      run_id: 'rev-d1',
      caller: 'submit',
      knowledge_ids: ['kc-1'],
      submit: {
        body: { response_md: '2' },
        question_id: 'q-durable',
        submitted_at: NOW.toISOString(),
        question_snapshot: { ...FROZEN_DURABLE },
      },
    },
  });
  await seedEvent({
    id: 'rev-d1',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q-durable',
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      user_response_md: '2',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc-1'],
      judge: { route: 'exact', score: 1, coarse_outcome: 'correct', auto_rated: true },
    },
    created_at: new Date('2026-09-20T00:00:08.000Z'),
  });

  // 3) 未回填 durable pending（blocked；pre-snapshot legacy 形态，无冻结 snapshot）。
  await seedEvent({
    id: 'pend-unbackfilled',
    action: 'experimental:judge_pending_attempt',
    subject_kind: 'question',
    subject_id: 'q-main',
    payload: {
      run_id: 'run-missing',
      caller: 'submit',
      knowledge_ids: ['kc-1'],
      submit: {
        body: { response_md: 'my frozen answer' },
        question_id: 'q-main',
        submitted_at: NOW.toISOString(),
      },
    },
  });

  // 4) rating-only review（FSRS 评级 → lineage，无映射行）。
  await seedEvent({
    id: 'rev-rating',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q-main',
    outcome: 'success',
    payload: { fsrs_rating: 'good', referenced_knowledge_ids: ['kc-1'] },
  });

  // 学习状态基线：apply 后必须逐字节不变（无学习重放）。
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: 'fsrs-1',
      subject_kind: 'knowledge',
      subject_id: 'kc-1',
      state: {
        due: NOW,
        stability: 2.5,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: null,
      },
      due_at: NOW,
      last_review_event_id: null,
    });
}

interface Fixture {
  capture: MigrationCapture;
  registry: RevisionRegistry;
}

async function buildFixture(): Promise<Fixture> {
  const capture = await captureMigrationCheckpoint(testDb());
  const registry: RevisionRegistry = {
    registry_version: 2,
    generated_by: 'db-test-corpus-import',
    entries: [
      registryEntry('q-main', 'rev-q-main', canonicalHash(ATTEMPT_SNAPSHOT)),
      registryEntry('q-durable', 'rev-q-durable', canonicalHash(FROZEN_DURABLE)),
    ],
  };
  return { capture, registry };
}

async function planInput(
  fixture: Fixture,
  registry: RevisionRegistry | null,
): Promise<BuildApplyPlanInput> {
  const classification = classifyMigrationCapture(fixture.capture);
  const contracts = await loadRevisionContracts(testDb(), registry);
  return {
    capture: fixture.capture,
    classification: {
      classification_version: 'db-test',
      classification_hash: canonicalHash({
        classification_version: 'db-test',
        records: classification.records,
        unresolved: classification.unresolved,
        deferred_replay: classification.deferred_replay,
      }),
      records: classification.records,
      unresolved: classification.unresolved,
      deferred_replay: classification.deferred_replay,
    },
    checkpoint_hash: 'chk-db-test',
    registry,
    revisionContracts: contracts,
  };
}

const RUN_ID = 'run-dbtest0000000000000000';

type ApplyPlan = ReturnType<typeof buildMigrationApplyPlan>;

async function runApply(
  plan: ApplyPlan,
  options: { db?: Db; dryRun?: boolean; runId?: string } = {},
) {
  return runMigrationApply({
    db: options.db ?? testDb(),
    plan,
    runId: options.runId ?? RUN_ID,
    fence: FENCE,
    dryRun: options.dryRun,
    batchSize: 1, // 单链一批：放大事务边界，钉住 crash 粒度
  });
}

async function truthCounts() {
  const db = testDb();
  const [mappings, issuances, groups, submissions, evaluations, heads] = await Promise.all([
    db.select({ id: assessment_identity_mapping.mapping_id }).from(assessment_identity_mapping),
    db.select({ id: assessment_issuance.issuance_id }).from(assessment_issuance),
    db.select({ id: evaluation_group.evaluation_group_id }).from(evaluation_group),
    db.select({ id: assessment_submission.submission_id }).from(assessment_submission),
    db.select({ id: evaluation.evaluation_id }).from(evaluation),
    db
      .select({ id: evaluation_effective_head.evaluation_group_id })
      .from(evaluation_effective_head),
  ]);
  return {
    mappings: mappings.length,
    issuances: issuances.length,
    groups: groups.length,
    submissions: submissions.length,
    evaluations: evaluations.length,
    heads: heads.length,
  };
}

beforeEach(async () => {
  await resetDb();
  await seedLegacyHistory();
});

describe('runMigrationApply — 全链路', () => {
  it('complete attempt 与 durable 回填 review 落 6 张真相表；head 为 non-effective 初态；图片证据原生保留', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    const result = await runApply(plan);
    assertReconciliationClean(result.report);

    // 两条 submission 链（att-1 + rev-d1）；evaluations = head judge + embedded。
    expect(result.report.reconciliation.submissions_present).toBe(2);
    expect(result.report.reconciliation.evaluations_present).toBe(2);
    const counts = await truthCounts();
    expect(counts).toMatchObject({
      issuances: 2,
      groups: 2,
      submissions: 2,
      evaluations: 2,
      heads: 2,
    });

    // head：随 submission 建立、不激活（§11/D4/§13 non-effective pending）。
    const heads = await testDb().select().from(evaluation_effective_head);
    for (const head of heads) {
      expect(head.effective_evaluation_id).toBeNull();
      expect(head.generation).toBe(0);
    }

    // evaluation：判词只作 legacy 证据 —— unit pending + aggregate pending_units。
    const evals = await testDb().select().from(evaluation);
    for (const row of evals) {
      expect(row.unit_results[0]).toMatchObject({ status: 'pending', scoring_unit_id: 'u1' });
      expect(row.aggregate).toMatchObject({ kind: 'unresolved', reason: 'pending_units' });
      expect(row.provenance).toMatchObject({ source: 'automatic' });
    }

    // submission：冻结作答 + 幂等键 + 图片证据原生保留（D5）。
    const submissions = await testDb().select().from(assessment_submission);
    expect(submissions.map((s) => s.idempotency_key).sort()).toEqual([
      'legacy-att-1',
      'legacy-rev-d1',
    ]);
    const withImage = submissions.find((s) => s.idempotency_key === 'legacy-att-1');
    expect(withImage).toBeDefined();
    const entry = withImage
      ? (withImage.response_set as { entries: Array<{ kind: string; evidence?: unknown[] }> })
          .entries[0]
      : undefined;
    expect(entry?.kind).toBe('open');
    expect(entry?.evidence?.[0]).toMatchObject({
      evidence_id: 'legacy-asset-1',
      kind: 'image',
      mime_type: 'image/png',
      bytes: 2048,
    });

    // 映射行：缺件 pending 带 PendingState + 恢复信封；lineage 类别无行。
    const mappings = await testDb().select().from(assessment_identity_mapping);
    const pendingMapping = mappings.find((m) => m.source_id === 'pend-unbackfilled');
    expect(pendingMapping?.status).toBe('pending');
    expect(pendingMapping?.evidence).toMatchObject({
      pending: { reason: 'infra_failure', retryable: true },
    });
    const envelope = pendingMapping?.evidence as {
      pending_recovery?: { run_id?: string; frozen_request?: { response_md?: string } };
    };
    expect(envelope?.pending_recovery?.run_id).toBe('run-missing');
    expect(envelope?.pending_recovery?.frozen_request?.response_md).toBe('my frozen answer');
    expect(mappings.find((m) => m.source_id === 'rev-rating')).toBeUndefined();

    // 账本：run + 5 阶段全 completed，run 行带 WAL 起点（audit:schema 写路径）。
    const phases = await testDb()
      .select()
      .from(migration_apply_phase)
      .where(eq(migration_apply_phase.run_id, RUN_ID));
    expect(phases.map((p) => p.status)).toEqual(new Array(5).fill('completed'));
    const run = await testDb()
      .select()
      .from(migration_apply_run)
      .where(eq(migration_apply_run.run_id, RUN_ID));
    expect(run[0]?.status).toBe('completed');
    expect(run[0]?.wal_lsn_start).not.toBeNull();
  });

  it('幂等重跑：零新行、阶段短路、reconciliation 仍全对账', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    const first = await runApply(plan);
    assertReconciliationClean(first.report);
    const before = await truthCounts();

    const second = await runApply(plan);
    assertReconciliationClean(second.report);
    expect(await truthCounts()).toEqual(before);
    expect(second.report.phases.find((p) => p.phase === 'apply_mappings')?.status).toBe('skipped');
    expect(second.report.phases.find((p) => p.phase === 'apply_submissions')?.status).toBe(
      'skipped',
    );
  });

  it('迁移后 head 激活（generation 1）被识别为合法演进：重跑仍 CLEAN 且显式上报', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    await runApply(plan);
    // settlement/runtime 激活 head（head 表无 immutable trigger —— 合法写路径）。
    const evalRow = (await testDb().select().from(evaluation))[0];
    const groupRow = (await testDb().select().from(evaluation_group))[0];
    if (evalRow === undefined || groupRow === undefined) return;
    await testDb()
      .update(evaluation_effective_head)
      .set({ effective_evaluation_id: evalRow.evaluation_id, generation: 1 })
      .where(eq(evaluation_effective_head.evaluation_group_id, groupRow.evaluation_group_id));

    const second = await runApply(plan);
    assertReconciliationClean(second.report); // 合法推进不判 divergence
    const activated = second.report.reconciliation.heads_current.find(
      (h) => h.evaluation_group_id === groupRow.evaluation_group_id,
    );
    expect(activated).toMatchObject({ generation: 1, post_migration_activation: true });
  });

  it('pending→resolved 续跑（P1-5）：先无 registry 落 pending，registry 后到同 checkpoint 重跑走显式接替', async () => {
    const fixture = await buildFixture();
    // 第一遍：无 registry —— 全部 pending，无 submission。
    const planNoRegistry = buildMigrationApplyPlan(await planInput(fixture, null));
    const first = await runApply(planNoRegistry);
    assertReconciliationClean(first.report);
    expect(first.report.reconciliation.submissions_present).toBe(0);
    const anchorLocator = 'event:attempt:att-1';
    const pendingRow = (await testDb()
      .select()
      .from(assessment_identity_mapping)
      .where(eq(assessment_identity_mapping.source_locator, anchorLocator))) as unknown as Array<{
      mapping_id: string;
      status: string;
      is_current: boolean;
    }>;
    expect(pendingRow[0]?.status).toBe('pending');

    // 第二遍：registry 后到（同 checkpoint/分类）—— mapped 新裁决接替旧 pending 行。
    const planWithRegistry = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    const second = await runApply(planWithRegistry, { runId: 'run-withregistry000000000' });
    assertReconciliationClean(second.report);
    expect(second.report.reconciliation.submissions_present).toBe(2);
    const rows = (await testDb()
      .select()
      .from(assessment_identity_mapping)
      .where(eq(assessment_identity_mapping.source_locator, anchorLocator))) as unknown as Array<{
      mapping_id: string;
      status: string;
      is_current: boolean;
      supersedes_mapping_id: string | null;
      target_revision_id: string | null;
    }>;
    const currentRow = rows.find((r) => r.is_current);
    const supersededRow = rows.find((r) => !r.is_current);
    expect(currentRow?.status).toBe('mapped');
    expect(currentRow?.target_revision_id).toBe('rev-q-main');
    expect(supersededRow?.status).toBe('pending'); // 旧裁决原样保留
    expect(currentRow?.supersedes_mapping_id).toBe(supersededRow?.mapping_id);
    expect(second.report.reconciliation.mapping_rows_superseded_in_run).toBeGreaterThan(0);
    // 第三遍：mapped plan 幂等重跑 —— 无新接替、无重复。
    const before = await truthCounts();
    const third = await runApply(planWithRegistry, { runId: 'run-withregistry000000000' });
    assertReconciliationClean(third.report);
    expect(await truthCounts()).toEqual(before);
  });

  it('crash 中断（apply_submissions 批事务失败）→ 续跑收敛，无重复行', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    const realDb = testDb();
    let txCalls = 0;
    const proxy = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            txCalls += 1;
            if (txCalls === 6) throw new Error('simulated crash mid-batch'); // 4 mapping 批 + 第 1 条 submission 链后
            return (
              target.transaction as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
            )(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Db;

    await expect(runApply(plan, { db: proxy })).rejects.toThrow('simulated crash mid-batch');
    // 首批（att-1 链）已提交、第二批失败 —— 部分状态。
    const midCounts = await truthCounts();
    expect(midCounts.submissions).toBe(1);
    const failedPhases = await testDb()
      .select()
      .from(migration_apply_phase)
      .where(eq(migration_apply_phase.run_id, RUN_ID));
    expect(failedPhases.find((p) => p.phase === 'apply_submissions')?.status).toBe('failed');
    const runRow = await testDb()
      .select()
      .from(migration_apply_run)
      .where(eq(migration_apply_run.run_id, RUN_ID));
    expect(runRow[0]?.status).toBe('failed');

    // 续跑：幂等收敛 + 补齐第二批，reconciliation 全对账。
    const resumed = await runApply(plan);
    assertReconciliationClean(resumed.report);
    expect(resumed.report.reconciliation.submissions_present).toBe(2);
    const submissionPhase = resumed.report.phases.find((p) => p.phase === 'apply_submissions');
    expect(submissionPhase?.status).toBe('completed');
    expect(submissionPhase?.rows_already_present).toBeGreaterThan(0);
  });

  it('divergence fail-visible：库内同 locator 不同判的当前映射行 → 拒绝并保持零 submission 写入', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    // 预插一条【非本工具】裁决的当前映射（模拟外部写入/篡改 —— 不可接替）。
    const conflictingRecord = plan.records.find(
      (r) => r.mapping !== null && r.mapping.source_id === 'att-1',
    );
    expect(conflictingRecord).toBeDefined();
    const conflicting = conflictingRecord?.mapping ?? null;
    expect(conflicting).toBeDefined();
    if (conflicting === null || conflicting === undefined) return;
    await testDb()
      .insert(assessment_identity_mapping)
      .values({
        mapping_id: 'amp-externalpreexisting00',
        source_kind: conflicting.source_kind,
        source_id: conflicting.source_id,
        source_locator: conflicting.source_locator,
        original_question_id: conflicting.original_question_id,
        evidence: { note: '外部旧判' },
        algorithm_version: 'other-tool/0.1',
        status: 'historical_unresolved',
        is_current: true,
        created_at: NOW,
      });

    await expect(runApply(plan)).rejects.toBeInstanceOf(MigrationApplyError);
    const counts = await truthCounts();
    expect(counts.issuances).toBe(0);
    expect(counts.submissions).toBe(0);
    const runRow = await testDb()
      .select()
      .from(migration_apply_run)
      .where(eq(migration_apply_run.run_id, RUN_ID));
    expect(runRow[0]?.status).toBe('failed');
    // 清掉冲突行后续跑收敛（修正工作流的职责在此测试内模拟）。
    await testDb()
      .delete(assessment_identity_mapping)
      .where(eq(assessment_identity_mapping.mapping_id, 'amp-externalpreexisting00'));
    const resumed = await runApply(plan);
    assertReconciliationClean(resumed.report);
  });

  it('preflight：registry 指向不存在的 revision → 拒绝，真相表零写入', async () => {
    const fixture = await buildFixture();
    const staleRegistry: RevisionRegistry = {
      registry_version: 2,
      generated_by: 'stale',
      entries: [registryEntry('q-main', 'rev-does-not-exist', canonicalHash(ATTEMPT_SNAPSHOT))],
    };
    // 装载即拒（registry 与目标库不一致在任何写入之前显形）。
    await expect(planInput(fixture, staleRegistry)).rejects.toThrow(/revision 在目标库不存在/);
    const counts = await truthCounts();
    expect(counts.submissions).toBe(0);
    expect(counts.issuances).toBe(0);
  });

  it('无 fence 拒绝写库；fence 被占同样拒绝', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    await expect(
      runMigrationApply({ db: testDb(), plan, runId: RUN_ID, fence: null }),
    ).rejects.toThrow(/fence/);
    await expect(
      runMigrationApply({ db: testDb(), plan, runId: RUN_ID, fence: NO_FENCE }),
    ).rejects.toThrow(/fence 获取失败/);
    const counts = await truthCounts();
    expect(counts.mappings).toBe(0);
  });

  it('dry-run：零写入（含账本），report 仍产出 plan 对账面', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    const result = await runApply(plan, { dryRun: true });
    expect(result.report.dry_run).toBe(true);
    expect(result.report.reconciliation.submissions_present).toBe(0);
    const counts = await truthCounts();
    expect(counts.mappings).toBe(0);
    const runs = await testDb().select().from(migration_apply_run);
    expect(runs).toHaveLength(0);
  });

  it('guarded 表 INSERT-only：UPDATE 被 DB trigger 拒绝（0105 不可变防线）', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    await runApply(plan);
    const submissions = await testDb().select().from(assessment_submission);
    expect(submissions.length).toBeGreaterThan(0);
    const victim = submissions[0];
    if (victim === undefined) return;
    let caught: unknown;
    try {
      await testDb()
        .update(assessment_submission)
        .set({ idempotency_key: 'tamper' })
        .where(eq(assessment_submission.submission_id, victim.submission_id));
    } catch (error) {
      caught = error;
    }
    const messageOf = (err: unknown, depth = 0): string => {
      if (err === null || typeof err !== 'object' || depth > 5) return '';
      const e = err as { message?: unknown; cause?: unknown };
      return `${typeof e.message === 'string' ? e.message : ''}\n${messageOf(e.cause, depth + 1)}`;
    };
    expect(caught).toBeDefined();
    expect(messageOf(caught)).toMatch(/append-only\/immutable/);
  });

  it('无学习重放：material_fsrs_state 逐字节不变', async () => {
    const before = await testDb().select().from(material_fsrs_state);
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    await runApply(plan);
    const after = await testDb().select().from(material_fsrs_state);
    expect(after).toEqual(before);
  });

  it('同 checkpoint 不同 classification 的第二 run → 拒绝静默叠加', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(await planInput(fixture, fixture.registry));
    await runApply(plan);
    const base = await planInput(fixture, fixture.registry);
    const plan2 = buildMigrationApplyPlan({
      ...base,
      classification: {
        ...base.classification,
        classification_version: 'db-test-v2',
        classification_hash: 'different-hash',
      },
    });
    await expect(
      runMigrationApply({
        db: testDb(),
        plan: plan2,
        runId: 'run-other000000000000000000',
        fence: FENCE,
      }),
    ).rejects.toThrow(/另一 classification 的 run/);
  });
});

describe('registry/contract 装载（DB 侧接线）', () => {
  it('registry 工件 digest 进 plan；契约从真表装载并保持五层形状', async () => {
    const fixture = await buildFixture();
    const base = await planInput(fixture, fixture.registry);
    const plan = buildMigrationApplyPlan(base);
    const parsed = parseRevisionRegistry(fixture.registry);
    expect(parsed.ok).toBe(true);
    expect(plan.registry_digest).toBe(canonicalHash(parsed.ok ? parsed.registry : null));
    const stored = await testDb()
      .select()
      .from(question_revision)
      .where(inArray(question_revision.revision_id, ['rev-q-main', 'rev-q-durable']));
    expect(stored).toHaveLength(2);
    // 契约装载（loadRevisionContracts）已在本文件所有 planInput 中实际执行。
  });

  it('question_revision 行损坏（非契约形状）→ 装载 fail-visible', async () => {
    // 直接种一行损坏的 revision（guard 表不可 UPDATE，从种子就是坏的）。
    const broken = revisionRow('rev-broken', 'grp-broken');
    broken.response_spec = { slots: [] } as unknown as typeof broken.response_spec;
    await testDb().insert(question_revision).values(broken);
    const registry: RevisionRegistry = {
      registry_version: 2,
      generated_by: 'broken-corpus',
      entries: [registryEntry('q-main', 'rev-broken', canonicalHash(ATTEMPT_SNAPSHOT))],
    };
    await expect(loadRevisionContracts(testDb(), registry)).rejects.toThrow(/契约/);
  });
});
