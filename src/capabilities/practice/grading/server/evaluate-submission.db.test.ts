// YUK-1047 — evaluateSubmission 持久化路径 DB 测试（testcontainer Postgres）。
//
// 断言（§4.3 Interface + grounding §4.2）：
//   1. 冻结输入（submission + published revision + issuance）→ candidate
//      evaluation 行落库；(submission_id, attempt) 单调递增；
//   2. 坐标不一致（submission.group ≠ 请求 group）⇒ fail-closed 拒绝；
//   3. retryable infra_failure ⇒ 记录 pending + aggregate=null，下一次调用
//      产生 attempt+1 的恢复尝试；
//   4. evaluateAttempt contract lane 端到端（登记 → 落库 → 投影）；
//   5. 绝不触碰 evaluation_effective_head（activation = YUK-1045 的范围）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateSubmission } from '@/capabilities/practice/grading/server/judge/evaluate-submission';
import { projectEvaluationToJudgeResult } from '@/capabilities/practice/grading/server/judge/evaluation-authority';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  ExecutionPlanT,
  ModelUnitOutcomeT,
  ResponseSetT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_group,
  event,
  question_revision,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { prepareFormalAttemptSubmission } from './assessment/attempt';

let db: Db = testDb();
beforeEach(async () => {
  await resetDb();
  db = testDb();
});

const NOW = new Date('2026-09-25T00:00:00.000Z');

// ---------- fixture 构造（镜像 apply.db.test.ts 的 contract-row 形状） ----------

interface SeedSpec {
  groupId: string;
  revisionId: string;
  issuanceId: string;
  submissionId: string;
  evalGroupId: string;
  slots?: ResponseSpecT['slots'];
  units?: ScoringBasisT['units'];
  assignments?: ExecutionPlanT['assignments'];
  entries?: ResponseSetT['entries'];
  partIds?: string[];
  blankScoresZero?: boolean;
  issuedPartIds?: string[];
  aggregation?: ScoringBasisT['aggregation'];
}

async function seedContractChain(spec: SeedSpec): Promise<void> {
  const partId = 'p1';
  const slots = spec.slots ?? [
    {
      slot_id: `${partId}::r`,
      part_id: partId,
      kind: 'single_choice',
      options: [
        { option_id: 'opt-a', label: 'A', text: 'alpha' },
        { option_id: 'opt-b', label: 'B', text: 'beta' },
      ],
    },
  ];
  const units = spec.units ?? [
    {
      scoring_unit_id: `${partId}::u`,
      slot_refs: [`${partId}::r`],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: {
        kind: 'option_set_key',
        accepted_option_ids: ['opt-a'],
      },
      points: 4,
    },
  ];
  const assignments = spec.assignments ?? [
    {
      scoring_unit_ids: [`${partId}::u`],
      executor: { kind: 'deterministic', comparator: 'exact_option_set' },
    },
  ];
  const partIds = spec.partIds ?? [partId];

  await testDb()
    .insert(question_revision)
    .values({
      revision_id: spec.revisionId,
      group_id: spec.groupId,
      revision_ordinal: 1,
      integrity_digest: canonicalHash({ revision: spec.revisionId }),
      structure: {
        group_id: spec.groupId,
        materials: [],
        parts: partIds.map((pid) => ({ part_id: pid, prompt_md: 'pick one', material_ids: [] })),
      },
      response_spec: { slots },
      scoring_basis: {
        units,
        aggregation: spec.aggregation ?? { kind: 'sum' },
        blank_scores_zero: spec.blankScoresZero ?? true,
      },
      execution_plan: {
        plan_version: 1,
        assignments,
        escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
      },
      supersedes_revision_id: null,
      availability: 'general_pool',
      published_by: null,
      published_at: NOW,
    });

  await testDb()
    .insert(assessment_issuance)
    .values({
      issuance_id: spec.issuanceId,
      revision_id: spec.revisionId,
      part_ids: spec.issuedPartIds ?? partIds,
      material_bindings: [],
      option_order: [{ slot_id: `${partIds[0]}::r`, option_ids: ['opt-a', 'opt-b'] }],
      container_occurrence_ref: null,
      claim_policy: 'one_time',
      claim_status: 'unclaimed',
      claimed_by_ref: null,
      issued_at: NOW,
    });

  await testDb()
    .insert(evaluation_group)
    .values({
      evaluation_group_id: spec.evalGroupId,
      submission_ids: [spec.submissionId],
      created_at: NOW,
    });

  await testDb()
    .insert(assessment_submission)
    .values({
      submission_id: spec.submissionId,
      issuance_id: spec.issuanceId,
      revision_id: spec.revisionId,
      evaluation_group_id: spec.evalGroupId,
      response_set: {
        entries: spec.entries ?? [
          { slot_id: `${partIds[0]}::r`, kind: 'choice', option_ids: ['opt-a'] },
        ],
      },
      group_evidence: [],
      idempotency_key: `idem-${spec.submissionId}`,
      submitted_at: NOW,
    });
}

describe('YUK-1047 formal entry candidate reuse', () => {
  // @invariant grading: a historical v1 submission cannot acquire late process or a changed candidate identity during formal replay.
  // @fails-if backfill capture on replay or change the v1 input identity; absent-process and byte-identical candidate assertions fail.
  it('reuses the same frozen candidate for preview and commit; changed execution intent conflicts', async () => {
    await seedContractChain({
      groupId: 'reuse_g',
      revisionId: 'reuse_r',
      issuanceId: 'reuse_i',
      submissionId: 'reuse_s',
      evalGroupId: 'reuse_eg',
    });
    const request = {
      submission_id: 'reuse_s',
      evaluation_group_id: 'reuse_eg',
      evaluation_key: 'submission:reuse_s',
    };
    const preview = await evaluateSubmission(db, request);
    const [original] = await db.select().from(assessment_submission);
    await prepareFormalAttemptSubmission(
      db,
      'solo_submit',
      'reuse_g',
      {
        issuance_id: original.issuance_id,
        submission_id: original.submission_id,
        evaluation_group_id: original.evaluation_group_id,
        idempotency_key: original.idempotency_key,
        response_set: original.response_set,
        group_evidence: original.group_evidence,
      },
      { reasoning_trace: 'a late capture must not backfill a historical submission' },
    );
    expect(
      await db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_accepted_process')),
    ).toHaveLength(0);
    expect(preview.record.provenance?.input_snapshot?.version).toBe(1);
    const commit = await evaluateSubmission(db, request);
    expect.soft(commit.replayed).toBe(true);
    expect.soft(commit.record).toEqual(preview.record);
    expect.soft(commit.created_at).toEqual(preview.created_at);
    expect.soft(await db.select().from(evaluation)).toHaveLength(1);
    await expect(
      evaluateSubmission(db, { ...request, provenance: { source: 'automatic', assisted: true } }),
    ).rejects.toMatchObject({ code: 'evaluation_key_conflict' });
  });
});

// @invariant grading: a new evaluation identity seals the same safe chart feedback that is stored, returned and replayed; raw executor output remains raw.
// @fails-if evaluation identity hashes unsafe feedback, persisted/projection bytes diverge, or replay rewrites the candidate.
it('seals safe chart feedback before assigning its durable evaluation identity', async () => {
  // Synthetic accepted Markdown; no provider output, learner record or measured cost.
  const chart = {
    v: 1,
    alt: 'Synthetic chart',
    kind: 'chart',
    chart: 'bar',
    x: { label: 'step', scale: 'category' },
    y: { label: 'value' },
    series: [{ name: 'synthetic', points: [['one', 999]] }],
  };
  const modelFence = [
    '```tlp-block',
    JSON.stringify({ ...chart, data_source: { kind: 'model' }, caption: 'model caption' }),
    '```',
  ].join('\n');
  const rawMd = [
    'Plain **Markdown**.',
    '```tlp-block',
    JSON.stringify({
      ...chart,
      data_source: { kind: 'tool_result', tool_use_id: 'synthetic-unbound', path: '/series' },
      caption: 'synthetic record claim',
    }),
    '```',
    modelFence,
  ].join('\n');
  const safeMd = [
    'Plain **Markdown**.',
    '```tlp-block',
    JSON.stringify({ ...chart, data_source: { kind: 'model' } }),
    '```',
    modelFence,
  ].join('\n');
  await seedContractChain({
    groupId: 'chart_g',
    revisionId: 'chart_r',
    issuanceId: 'chart_i',
    submissionId: 'chart_s',
    evalGroupId: 'chart_eg',
    units: [
      {
        scoring_unit_id: 'p1::u',
        slot_refs: ['p1::r'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        points: 4,
        criterion: {
          kind: 'rule_reference',
          rule_id: 'synthetic-rule',
          statement_md: 'Select alpha.',
          source: 'official',
        },
      },
    ],
    assignments: [
      {
        scoring_unit_ids: ['p1::u'],
        executor: {
          kind: 'model_executor',
          task_kind: 'AssessmentRuleJudgeTask',
          admitted_slice_id: 'synthetic-slice',
          max_cost_usd_micros: 1000,
        },
      },
    ],
  });
  const rawOutcome: ModelUnitOutcomeT = {
    kind: 'scored',
    points_awarded: 4,
    matched: { rule_id: 'synthetic-rule', option_ids: [] },
    feedback_md: rawMd,
    evidence_citations: [],
    confidence: 1,
    run_refs: ['synthetic:chart-output'],
    cost_usd_micros: 0,
  };
  const request = {
    submission_id: 'chart_s',
    evaluation_group_id: 'chart_eg',
    evaluation_key: 'submission:chart_s',
    model_executor: async () => rawOutcome,
  };
  const result = await evaluateSubmission(db, request);
  const [stored] = await db
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, result.record.evaluation_id));
  expect(stored.unit_results).toEqual(result.record.unit_results);
  expect(stored.unit_results[0]).toMatchObject({ feedback_md: safeMd, points_awarded: 4 });
  const { evaluation_id, ...sealedContent } = result.record;
  expect(evaluation_id).toBe(`eva_${canonicalHash(sealedContent).slice(0, 48)}`);
  expect(projectEvaluationToJudgeResult(result.record, result.scoring_basis).feedback_md).toBe(
    safeMd,
  );
  expect(result.record.run_refs).toEqual(rawOutcome.run_refs);
  expect(rawOutcome.feedback_md).toBe(rawMd);
  const replay = await evaluateSubmission(db, {
    ...request,
    expected_evaluation_id: evaluation_id,
  });
  expect(replay.replayed).toBe(true);
  expect(replay.record).toEqual(result.record);
  expect(replay.created_at).toEqual(result.created_at);
  expect(await db.select().from(evaluation)).toHaveLength(1);
});
