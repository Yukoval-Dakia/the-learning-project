// YUK-1445 / ADR-0074 D3a — partial_unknown_points 结算边界 DB 测试。
//
// 【PREPARED — NOT RUN】本 lane 无 DB 窗口：父线程安排 DB window 与 exact-head
// CI 后执行（owner 规则：不 DB/runtime/provider 自跑）。本文件为 task-owned
// 新文件，不改不碰 1470 线拥有的 settle.ts / activate.ts / settle*.db.test.ts，
// 只消费其公开入口 —— 真实链路：publishQuestionGroup → 真实
// evaluateSubmissionCore → activateEvaluation(learningSettlement) → 公开读
// projectEvaluationToJudgeResult。无内部 mock/假 admission 替代真实判分
// （admission evidence 仅按既有 db 测试惯例作 fixture 播种）；时钟用冻结常量
// NOW（与 settle.db.test.ts 同款外部时钟约定）。
//
// 边界不变量（coordinator 最终裁决）：
//   1. 【现在即可执行】多空白 + 无印规则 2/3 对 ⇒ 调度面 rating=null（无
//      FSRS 写、无 θ̂ 写、KC 全弃权）—— 调度面 verdict=unsupported(reason=
//      partial_unknown_points) 已落 core；
//   2. 【pin 待补丁】公开读面 learner 看到 partial「部分对、分数未知」
//      （score=null + typed 2/3 计数）。当前 JudgeResultV2 的 'partial'
//      变体强制 score∈(0,0.85)（src/core/schema/capability.ts:83-87），
//      score-null partial 无合法承载 —— 本断言组钉住目标契约，待父/
//      coordinator 裁决 capability schema 最小补丁（新判别值或 score
//      可空，见 docs/planning/…-d3a-matching-sentence-breaks.md §9 的
//      两个候选 diff）后转绿；在此之前运行本用例将在此处如实失败，
//      不是误报。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectEvaluationToJudgeResult } from '@/capabilities/practice/server/judge/evaluation-authority';
import {
  EvaluationRecord,
  type EvaluationRecordT,
  PublishedQuestionRevision,
  type PublishedQuestionRevisionT,
  type QuestionGroupStructureT,
  type ResponseSetT,
  ScoringBasis,
  evaluateSubmissionCore,
} from '@/core/schema/assessment';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_group,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import type { NormalizableQuestionRow } from '@/server/questions/contract-normalizer';
import { normalizeQuestionRowToContract } from '@/server/questions/contract-normalizer';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation, insertInitialEvaluationHead } from './activate';
import { ASSESSMENT_SETTLEMENT_ACTION, learningSettlement } from './settle';

const NOW = new Date('2026-10-11T00:00:00Z');
const KC = 'yuk1445_kc';
const ADMITTED_EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

/** D3a 卷面契约：配对（无印规则）+ 两个可空白文本单元；blank_scores_zero=true。 */
function d3aContract(groupId: string) {
  const structure: QuestionGroupStructureT = {
    group_id: groupId,
    materials: [],
    parts: [{ part_id: 'p1', prompt_md: '把作家与作品配对，并完成填空。', material_ids: [] }],
  };
  const response_spec = {
    slots: [
      {
        slot_id: 'm1',
        part_id: 'p1',
        kind: 'matching',
        left_items: [
          { item_id: 'i1', label: 'A', text: '鲁迅' },
          { item_id: 'i2', label: 'B', text: '沈从文' },
          { item_id: 'i3', label: 'C', text: '老舍' },
        ],
        right_options: [
          { option_id: 'r1', label: '1', text: '《边城》' },
          { option_id: 'r2', label: '2', text: '《呐喊》' },
          { option_id: 'r3', label: '3', text: '《茶馆》' },
        ],
      },
      { slot_id: 't1', part_id: 'p1', kind: 'text' },
      { slot_id: 't2', part_id: 'p1', kind: 'text' },
    ],
  };
  const scoring_basis = {
    units: [
      {
        scoring_unit_id: 'u_match',
        slot_refs: ['m1'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: {
          kind: 'matching_pairs_key',
          accepted_pairs: [
            { item_id: 'i1', option_id: 'r2' },
            { item_id: 'i2', option_id: 'r1' },
            { item_id: 'i3', option_id: 'r3' },
          ],
        },
        points: 6,
      },
      {
        scoring_unit_id: 'u_t1',
        slot_refs: ['t1'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: { kind: 'text_key', accepted_texts: ['答'], normalization: 'trim' },
        points: 2,
      },
      {
        scoring_unit_id: 'u_t2',
        slot_refs: ['t2'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: { kind: 'text_key', accepted_texts: ['答'], normalization: 'trim' },
        points: 2,
      },
    ],
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  };
  const execution_plan = {
    plan_version: 1,
    assignments: [
      {
        scoring_unit_ids: ['u_match'],
        executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
      },
      {
        scoring_unit_ids: ['u_t1', 'u_t2'],
        executor: { kind: 'deterministic', comparator: 'exact_text' },
      },
    ],
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  };
  const contract = { structure, response_spec, scoring_basis, execution_plan };
  return { ...contract, integrity_digest: contractIntegrityDigest(contract) };
}

/** 作答：配对 2/3 正确（i3 错配）+ 两个主动空白。 */
const D3A_RESPONSE: ResponseSetT = {
  entries: [
    {
      slot_id: 'm1',
      kind: 'matching',
      pairs: [
        { item_id: 'i1', option_id: 'r2' },
        { item_id: 'i2', option_id: 'r1' },
        { item_id: 'i3', option_id: 'r1' },
      ],
    },
    { slot_id: 't1', kind: 'text', text_md: '' },
    { slot_id: 't2', kind: 'text', text_md: '' },
  ],
};

describe('YUK-1445 D3a — partial_unknown_points 结算边界（DB，prepared not run）', () => {
  beforeEach(resetDb);

  it('多空白 + 无印规则 2/3 对：rating=null 无 FSRS/θ̂/KC 写；公开读显示 partial 2/3、score=null', async () => {
    const db = testDb();
    await db.insert(knowledge).values({
      id: KC,
      name: KC,
      domain: null,
      parent_id: null,
      approval_status: 'approved',
      proposed_by_ai: false,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
    await db.insert(question).values({
      id: 'yuk1445_q',
      kind: 'choice',
      prompt_md: 'D3a 边界卷',
      reference_md: 'B',
      knowledge_ids: [KC],
      difficulty: 3,
      source: 'web_sourced',
      variant_depth: 0,
      choices_md: ['甲', '乙', '丙'],
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
    const [row] = await db.select().from(question).where(eq(question.id, 'yuk1445_q')).limit(1);
    const n = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
    const contract = d3aContract(n.group_id);
    const published = await publishQuestionGroup(db, {
      group_id: n.group_id,
      contract: contract as Parameters<typeof publishQuestionGroup>[1]['contract'],
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      actorRef: 'test:publish',
      now: NOW,
    });
    if (published.status !== 'published') throw new Error(`publish: ${published.status}`);

    const revision: PublishedQuestionRevisionT = PublishedQuestionRevision.parse({
      revision_id: published.revision_id,
      group_id: n.group_id,
      revision_ordinal: 1,
      integrity_digest: contract.integrity_digest,
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      published_at: NOW.toISOString(),
      supersedes_revision_id: null,
    });

    const submissionId = 'yuk1445_sub';
    const groupId = 'yuk1445_grp';
    await db.insert(assessment_issuance).values({
      issuance_id: 'yuk1445_iss',
      revision_id: published.revision_id,
      part_ids: ['p1'],
      material_bindings: [],
      option_order: [],
      claim_policy: 'one_time',
      claim_status: 'claimed',
      claimed_by_ref: 'occ_1',
      issued_at: NOW,
    });
    await db.transaction(async (tx) => {
      await tx.insert(evaluation_group).values({
        evaluation_group_id: groupId,
        submission_ids: [submissionId],
        created_at: NOW,
      });
      await tx.insert(assessment_submission).values({
        submission_id: submissionId,
        issuance_id: 'yuk1445_iss',
        revision_id: published.revision_id,
        evaluation_group_id: groupId,
        response_set: D3A_RESPONSE,
        group_evidence: [],
        idempotency_key: 'yuk1445_idem',
        submitted_at: NOW,
      });
      await insertInitialEvaluationHead(tx, {
        evaluation_group_id: groupId,
        submission_id: submissionId,
        now: NOW,
      });
    });

    // 真实判分（无内部 mock）：partial 聚合由 evaluateSubmissionCore 产出。
    const graded = await evaluateSubmissionCore({
      evaluation_id: 'yuk1445_ev1',
      submission: {
        submission_id: submissionId,
        issuance_id: 'yuk1445_iss',
        revision_id: published.revision_id,
        evaluation_group_id: groupId,
        response_set: D3A_RESPONSE,
        group_evidence: [],
        idempotency_key: 'yuk1445_idem',
        submitted_at: NOW.toISOString(),
      },
      revision,
      attempt: 1,
    });
    expect(graded.record.aggregate).toMatchObject({
      kind: 'partial_unknown_points',
      known_points: 0,
      partial_units: [{ scoring_unit_id: 'u_match', correct_count: 2, total_count: 3 }],
    });

    await db.insert(evaluation).values({
      evaluation_id: 'yuk1445_ev1',
      evaluation_group_id: groupId,
      submission_id: submissionId,
      attempt: 1,
      status: graded.record.status,
      unit_results: graded.record.unit_results as never,
      aggregate: graded.record.aggregate as never,
      plan_digest: null,
      run_refs: [],
      provenance: { source: 'automatic', assisted: false },
    } as never);

    const activation = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        {
          evaluation_id: 'yuk1445_ev1',
          expected_effective_id: null,
          expected_generation: 0,
        },
        { settle: learningSettlement, actorRef: 'test', now: NOW },
      ),
    );
    expect(activation.status).toBe('activated');

    // 边界 1：调度面零写 —— rating=null、θ̂ abstain、KC 全弃权。
    const [receipt] = await db
      .select()
      .from(event)
      .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
    expect(receipt).toBeDefined();
    const inputs = (
      receipt.payload as { inputs: { rating: unknown; theta: unknown; kcObservations: unknown } }
    ).inputs;
    expect(inputs.rating).toBeNull();
    expect(inputs.theta).toMatchObject({ applied: false, abstainReason: 'no_kc_evidence' });
    expect(inputs.kcObservations).toEqual([
      { kc_id: KC, bit: 'abstain', basis: 'no_supported_evidence' },
    ]);
    const [fsrs] = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, `knowledge:${KC}`));
    expect(fsrs).toBeUndefined();
    const [mastery] = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, `knowledge:${KC}`));
    expect(mastery).toBeUndefined();

    // 边界 2：公开读面 —— learner 看到 partial「部分对、分数未知」，非 unsupported。
    const [evaluationRow] = await db
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, 'yuk1445_ev1'));
    const record: EvaluationRecordT = EvaluationRecord.parse({
      evaluation_id: evaluationRow.evaluation_id,
      evaluation_group_id: evaluationRow.evaluation_group_id,
      submission_id: evaluationRow.submission_id,
      attempt: evaluationRow.attempt,
      status: evaluationRow.status,
      unit_results: evaluationRow.unit_results,
      aggregate: evaluationRow.aggregate,
      plan_digest: evaluationRow.plan_digest,
      run_refs: evaluationRow.run_refs ?? [],
      provenance: evaluationRow.provenance ?? undefined,
    });
    const judged = projectEvaluationToJudgeResult(
      record,
      ScoringBasis.parse(contract.scoring_basis),
    );
    expect(judged.coarse_outcome).toBe('partial');
    expect(judged.score).toBeNull();
    expect(judged.feedback_md).toContain('partly correct');
    expect(judged.evidence_json).toMatchObject({
      known_points: 0,
      partial_units: [{ scoring_unit_id: 'u_match', correct_count: 2, total_count: 3 }],
    });
  });
});
