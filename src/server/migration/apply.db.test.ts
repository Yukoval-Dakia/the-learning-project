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
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  MigrationApplyError,
  type MigrationApplyFence,
  assertReconciliationClean,
  runMigrationApply,
} from './apply';
import { captureMigrationCheckpoint } from './capture';

// YUK-1050 — apply 执行器 DB 测试：真表 seed（含 corpus question_revision +
// legacy attempt/judge/review/pending/draft）→ 真实 capture reader → 分类 →
// 规划 → 分阶段执行。钉住：幂等重跑零重复、crash 中断后续跑收敛、
// divergence fail-visible、fence 纪律、guarded 表 INSERT-only（DB trigger）、
// 学习状态表零触碰（无学习重放）。

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
          points: null,
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
  snapshotDigest: string | null,
): RevisionRegistryEntry {
  return {
    question_id: questionId,
    revision_id: revisionId,
    part_ids: ['p1'],
    slot_id: 's1',
    scoring_unit_id: 'u1',
    snapshot_digest: snapshotDigest,
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

/** 代表性历史语料：complete attempt 链 + durable 回填 review + pending/draft/lineage。 */
async function seedLegacyHistory(): Promise<void> {
  // corpus 导入产物（YUK-1043 lane 的接缝工件在 apply 侧以 registry 表达）。
  await testDb()
    .insert(question_revision)
    .values([
      revisionRow('rev-q-main', 'grp-q-main'),
      revisionRow('rev-q-durable', 'grp-q-durable'),
    ]);

  // 1) complete attempt 链：attempt（带冻结 snapshot）+ head judge verdict。
  await seedEvent({
    id: 'att-1',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q-main',
    outcome: 'failure',
    payload: {
      answer_md: '3',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc-1'],
      question_snapshot: ATTEMPT_SNAPSHOT,
    },
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
    created_at: NOW,
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

  // 3) 未回填 durable pending（blocked，保留 run/request 身份；pre-snapshot
  //    legacy 形态：judge-run-payload 旧路径无冻结 snapshot，identity 只能靠
  //    registry 断言绑定）。
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
    created_at: NOW,
  });

  // 4) rating-only review（FSRS 评级 → lineage，无映射行）。
  await seedEvent({
    id: 'rev-rating',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q-main',
    outcome: 'success',
    payload: { fsrs_rating: 'good', referenced_knowledge_ids: ['kc-1'] },
    created_at: NOW,
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
    registry_version: 1,
    generated_by: 'db-test-corpus-import',
    entries: [
      registryEntry('q-main', 'rev-q-main', canonicalHash(ATTEMPT_SNAPSHOT)),
      registryEntry('q-durable', 'rev-q-durable', canonicalHash(FROZEN_DURABLE)),
    ],
  };
  return { capture, registry };
}

function planInput(fixture: Fixture): BuildApplyPlanInput {
  const classification = classifyMigrationCapture(fixture.capture);
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
    registry: fixture.registry,
  };
}

const RUN_ID = 'run-dbtest0000000000000000';

async function runApply(
  plan: ReturnType<typeof buildMigrationApplyPlan>,
  options: { db?: Db; dryRun?: boolean } = {},
) {
  return runMigrationApply({
    db: options.db ?? testDb(),
    plan,
    runId: RUN_ID,
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
  it('complete attempt 与 durable 回填 review 落 6 张真相表，reconciliation 全对账', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    const result = await runApply(plan);
    assertReconciliationClean(result.report);

    // 两条 submission 链（att-1 + rev-d1）；evaluations = head judge + embedded。
    expect(result.report.reconciliation.submissions_present).toBe(2);
    expect(result.report.reconciliation.evaluations_present).toBe(2);
    const counts = await truthCounts();
    expect(counts).toMatchObject({
      mappings: expect.any(Number),
      issuances: 2,
      groups: 2,
      submissions: 2,
      evaluations: 2,
      heads: 2,
    });

    // head 语义：att-1 → jud-1 eval 生效；rev-d1 → embedded eval 生效。
    const heads = await testDb().select().from(evaluation_effective_head);
    for (const head of heads) {
      expect(head.effective_evaluation_id).not.toBeNull();
      expect(head.generation).toBe(1);
      const evalRow = await testDb()
        .select()
        .from(evaluation)
        .where(eq(evaluation.evaluation_id, head.effective_evaluation_id ?? ''));
      expect(evalRow[0]?.status).toBe('completed');
      expect(evalRow[0]?.provenance).toMatchObject({ source: 'automatic' });
    }

    // submission 冻结作答 + 幂等键。
    const submissions = await testDb().select().from(assessment_submission);
    expect(submissions.map((s) => s.idempotency_key).sort()).toEqual([
      'legacy-att-1',
      'legacy-rev-d1',
    ]);
    const texts = submissions
      .map((s) => (s.response_set as { entries: Array<{ text_md: string }> }).entries[0]?.text_md)
      .sort();
    expect(texts).toEqual(['2', '3']);

    // 映射行：identity 可由 registry 断言绑定的缺件 pending 仍落 mapped（身份
    // 已知），PendingState/run 身份在 evidence；lineage 类别无行。
    const mappings = await testDb().select().from(assessment_identity_mapping);
    const pendingMapping = mappings.find((m) => m.source_id === 'pend-unbackfilled');
    expect(pendingMapping?.status).toBe('mapped');
    expect(pendingMapping?.evidence).toMatchObject({
      pending: { reason: 'infra_failure', retryable: true },
      run_id: 'run-missing',
    });
    expect(pendingMapping?.evidence).toMatchObject({
      resolution: { registry_snapshot_binding: 'registry_assertion' },
    });
    expect(mappings.find((m) => m.source_id === 'rev-rating')).toBeUndefined();

    // 账本：run + 5 阶段全 completed，有 WAL/时长观测字段位。
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
  });

  it('幂等重跑：零新行、全部 already_present、reconciliation 仍全对账', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    const first = await runApply(plan);
    assertReconciliationClean(first.report);
    const before = await truthCounts();

    const second = await runApply(plan);
    assertReconciliationClean(second.report);
    const after = await truthCounts();
    expect(after).toEqual(before);
    const mappingPhase = second.report.phases.find((p) => p.phase === 'apply_mappings');
    const submissionPhase = second.report.phases.find((p) => p.phase === 'apply_submissions');
    // 重跑：阶段被 completed 状态短路（resume 语义），无重复写。
    expect(mappingPhase?.status).toBe('skipped');
    expect(submissionPhase?.status).toBe('skipped');
  });

  it('crash 中断（apply_submissions 批事务失败）→ 续跑收敛，无重复行', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    const realDb = testDb();
    let txCalls = 0;
    const proxy = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            txCalls += 1;
            if (txCalls === 2) throw new Error('simulated crash mid-batch');
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

  it('divergence fail-visible：库内同 locator 不同判的映射行 → 拒绝并保持零写入', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    // 预插一条与 plan 冲突的当前映射（mapping 表不受 immutable trigger 保护，
    // 可由修正工作流写入 —— 这里模拟被外部篡改/旧版本写入的场景）。
    const conflictingRecord = plan.records.find(
      (r) => r.mapping !== null && r.mapping.source_id === 'att-1',
    );
    expect(conflictingRecord).toBeDefined();
    const conflicting = conflictingRecord?.mapping ?? undefined;
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
    // 失败可见：run 记 failed。
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
      registry_version: 1,
      generated_by: 'stale',
      entries: [registryEntry('q-main', 'rev-does-not-exist', canonicalHash(ATTEMPT_SNAPSHOT))],
    };
    const plan = buildMigrationApplyPlan({ ...planInput(fixture), registry: staleRegistry });
    await expect(runApply(plan)).rejects.toThrow(/revision 在目标库不存在/);
    const counts = await truthCounts();
    expect(counts.submissions).toBe(0);
    expect(counts.issuances).toBe(0);
  });

  it('无 fence 拒绝写库；fence 被占同样拒绝', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
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
    const plan = buildMigrationApplyPlan(planInput(fixture));
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
    const plan = buildMigrationApplyPlan(planInput(fixture));
    await runApply(plan);
    const submissions = await testDb().select().from(assessment_submission);
    expect(submissions.length).toBeGreaterThan(0);
    const victim = submissions[0];
    if (victim === undefined) return;
    // drizzle 会把 DB 错误包进 "Failed query" 外层 —— 沿 cause 链找 trigger 消息。
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
    const plan = buildMigrationApplyPlan(planInput(fixture));
    await runApply(plan);
    const after = await testDb().select().from(material_fsrs_state);
    expect(after).toEqual(before);
  });

  it('同 checkpoint 不同 classification 的第二 run → 拒绝静默叠加', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    await runApply(plan);
    const otherClassification = {
      ...planInput(fixture),
      classification: {
        ...planInput(fixture).classification,
        classification_version: 'db-test-v2',
        classification_hash: 'different-hash',
      },
    };
    const plan2 = buildMigrationApplyPlan(otherClassification);
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

describe('parseRevisionRegistry — DB 侧接线', () => {
  it('registry 工件 digest 进 plan（语料导入变化不被吞掉）', async () => {
    const fixture = await buildFixture();
    const plan = buildMigrationApplyPlan(planInput(fixture));
    const parsed = parseRevisionRegistry(fixture.registry);
    expect(parsed.ok).toBe(true);
    expect(plan.registry_digest).toBe(canonicalHash(parsed.ok ? parsed.registry : null));
    const stored = await testDb()
      .select()
      .from(question_revision)
      .where(inArray(question_revision.revision_id, ['rev-q-main', 'rev-q-durable']));
    expect(stored).toHaveLength(2);
  });
});
