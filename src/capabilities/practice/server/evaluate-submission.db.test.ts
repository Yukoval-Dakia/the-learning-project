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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import { evaluateAttempt } from '@/capabilities/practice/server/judge/evaluation-authority';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  ExecutionPlanT,
  ResponseSetT,
  ResponseSpecT,
  ScoringBasisT,
  ScoringUnitResultT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  question_revision,
} from '@/db/schema';
import {
  beginTestTransaction,
  resetDb,
  rollbackTestTransaction,
  testDb,
} from '../../../../tests/helpers/db';

let db: Db = testDb();

beforeAll(resetDb);

beforeEach(async () => {
  await beginTestTransaction();
  db = testDb();
});

afterEach(async () => {
  await rollbackTestTransaction();
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
        aggregation: { kind: 'sum' },
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
      part_ids: partIds,
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

// ---------- tests ----------

describe('evaluateSubmission (persisted §4.3 path)', () => {
  it('deterministic hit: writes a completed candidate with points_total aggregate', async () => {
    await seedContractChain({
      groupId: 'g1',
      revisionId: 'rev-1',
      issuanceId: 'iss-1',
      submissionId: 'sub-1',
      evalGroupId: 'eg-1',
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-1',
      evaluation_group_id: 'eg-1',
    });
    expect(out.replayed).toBe(false);
    expect(out.record.attempt).toBe(1);
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 4 });
    expect(out.record.evaluation_id.startsWith('eva_')).toBe(true);
    expect(out.record.plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const rows = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.submission_id, 'sub-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_results[0]).toMatchObject({
      status: 'scored',
      scoring_unit_id: 'p1::u',
      points_awarded: 4,
    });
    // candidate 永不生效 —— head 行未被本模块触碰（不存在也是合法的）。
    const heads = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'eg-1'));
    expect(heads).toHaveLength(0);
  });

  it('binary comparator: wrong answer scores 0 (no partial credit)', async () => {
    await seedContractChain({
      groupId: 'g2',
      revisionId: 'rev-2',
      issuanceId: 'iss-2',
      submissionId: 'sub-2',
      evalGroupId: 'eg-2',
      entries: [{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-b'] }],
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-2',
      evaluation_group_id: 'eg-2',
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 0 });
  });

  it('unadmitted model_executor ⇒ withhold ⇒ completed + unresolved (no fake zero)', async () => {
    await seedContractChain({
      groupId: 'g3',
      revisionId: 'rev-3',
      issuanceId: 'iss-3',
      submissionId: 'sub-3',
      evalGroupId: 'eg-3',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade the short answer',
            source: 'official',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: null,
          },
        },
      ],
      entries: [{ slot_id: 'p1::r', kind: 'text', text_md: 'student work' }],
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-3',
      evaluation_group_id: 'eg-3',
    });
    expect(out.record.status).toBe('completed');
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'unjudgeable' },
    });
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
    expect(out.model_units_invoked).toBe(0);
  });

  it('admitted model_executor without port ⇒ retryable infra_failure ⇒ pending record; retry writes attempt 2', async () => {
    await seedContractChain({
      groupId: 'g4',
      revisionId: 'rev-4',
      issuanceId: 'iss-4',
      submissionId: 'sub-4',
      evalGroupId: 'eg-4',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade it',
            source: 'manual',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: 'slice-zh-text-v1',
          },
        },
      ],
      entries: [{ slot_id: 'p1::r', kind: 'text', text_md: 'answer' }],
    });

    const first = await evaluateSubmission(db, {
      submission_id: 'sub-4',
      evaluation_group_id: 'eg-4',
    });
    expect(first.record.status).toBe('pending');
    expect(first.record.aggregate).toBeNull();

    // 恢复尝试：注入端口后产出 attempt=2 的 completed candidate。
    const second = await evaluateSubmission(db, {
      submission_id: 'sub-4',
      evaluation_group_id: 'eg-4',
      model_executor: async () => ({
        kind: 'scored',
        points_awarded: 6,
        matched: { rule_id: 'r1', option_ids: [] },
        run_refs: ['run-xyz'],
        evidence_citations: [],
        cost_usd_micros: 1200,
      }),
    });
    expect(second.record.attempt).toBe(2);
    expect(second.record.status).toBe('completed');
    expect(second.record.aggregate).toMatchObject({ kind: 'points_total', points: 6 });
    expect(second.record.run_refs).toEqual(['run-xyz']);
    expect(second.spent_cost_usd_micros).toBe(1200);

    const rows = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.submission_id, 'sub-4'));
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2]);
  });

  it('submission/group coordinate mismatch ⇒ group_scope_mismatch (fail-closed)', async () => {
    await seedContractChain({
      groupId: 'g5',
      revisionId: 'rev-5',
      issuanceId: 'iss-5',
      submissionId: 'sub-5',
      evalGroupId: 'eg-5',
    });
    await expect(
      evaluateSubmission(db, {
        submission_id: 'sub-5',
        evaluation_group_id: 'eg-OTHER',
      }),
    ).rejects.toMatchObject({ code: 'group_scope_mismatch' });
  });

  it('unknown submission ⇒ submission_not_found', async () => {
    await expect(
      evaluateSubmission(db, {
        submission_id: 'ghost',
        evaluation_group_id: 'eg-x',
      }),
    ).rejects.toMatchObject({ code: 'submission_not_found' });
  });

  it('manual_assert writes a completed manual-provenance candidate', async () => {
    await seedContractChain({
      groupId: 'g6',
      revisionId: 'rev-6',
      issuanceId: 'iss-6',
      submissionId: 'sub-6',
      evalGroupId: 'eg-6',
    });
    const asserted: ScoringUnitResultT[] = [
      {
        status: 'scored',
        scoring_unit_id: 'p1::u',
        points_awarded: 4,
        scored_because: 'response',
        evidence_citations: [],
      },
    ];
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-6',
      evaluation_group_id: 'eg-6',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: asserted,
    });
    expect(out.record.provenance).toMatchObject({ source: 'manual' });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 4 });
  });
});

describe('evaluateAttempt — contract lane end-to-end', () => {
  it('contract ref ⇒ evaluateSubmission + JudgeResultV2 projection', async () => {
    await seedContractChain({
      groupId: 'g7',
      revisionId: 'rev-7',
      issuanceId: 'iss-7',
      submissionId: 'sub-7',
      evalGroupId: 'eg-7',
      entries: [{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-a'] }],
    });
    const out = await evaluateAttempt({
      entry: 'conjecture_probe',
      db,
      contract: { submission_id: 'sub-7', evaluation_group_id: 'eg-7' },
    });
    expect(out.lane).toBe('contract');
    expect(out.entry).toBe('conjecture_probe');
    expect(out.evaluation.record.attempt).toBe(1);
    expect(out.result.coarse_outcome).toBe('correct');
    expect(out.result.score).toBe(1);
  });
});
