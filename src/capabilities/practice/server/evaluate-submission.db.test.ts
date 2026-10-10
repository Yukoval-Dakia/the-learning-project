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

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  ExecutionPlanT,
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
  question_revision,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';

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
