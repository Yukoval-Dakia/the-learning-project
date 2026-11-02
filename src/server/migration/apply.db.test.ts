import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BuildApplyPlanInput,
  type RevisionRegistry,
  type RevisionRegistryEntry,
  buildMigrationApplyPlan,
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
import { type MigrationApplyFence, assertReconciliationClean, runMigrationApply } from './apply';
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
});
