// PREPARED — NOT RUN. Parent owns the DB window and runtime acceptance.
// Real deterministic grading seals admission/input snapshots before activation.
// Publication evidence is a fixture, not actual-provider or model admission evidence.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import { projectEvaluationToJudgeResult } from '@/capabilities/practice/server/judge/evaluation-authority';
import {
  EvaluationRecord,
  ExecutionPlan,
  type QuestionGroupStructureT,
  type ResponseSetT,
  ResponseSpec,
  ScoringBasis,
} from '@/core/schema/assessment';
import { JudgeResultV2 } from '@/core/schema/capability';
import {
  assessment_issuance,
  assessment_submission,
  evaluation_group,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { resolveVerdictForGroup } from '@/kernel/read-models/assessment-verdict';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
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

/** A single matching unit with no printed scoring rule. */
function d3aContract(groupId: string): Parameters<typeof publishQuestionGroup>[1]['contract'] {
  const structure: QuestionGroupStructureT = {
    group_id: groupId,
    materials: [],
    parts: [{ part_id: 'p1', prompt_md: '把作家与作品配对。', material_ids: [] }],
  };
  const response_spec = ResponseSpec.parse({
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
    ],
  });
  const scoring_basis = ScoringBasis.parse({
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
    ],
    aggregation: { kind: 'sum' },
    blank_scores_zero: false,
  });
  const execution_plan = ExecutionPlan.parse({
    plan_version: 1,
    assignments: [
      {
        scoring_unit_ids: ['u_match'],
        executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
      },
    ],
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  });
  const contract = { structure, response_spec, scoring_basis, execution_plan };
  return { ...contract, integrity_digest: contractIntegrityDigest(contract) };
}

/** Two correct pairs and one incorrect pair. */
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
  ],
};

describe('YUK-1445 D3a — partial_unknown_points 结算边界（DB，prepared not run）', () => {
  beforeEach(resetDb);

  // @invariant grading: no-rule 2/3 correctness remains public with null score and no learning mutation.
  // @fails-if grading loses typed counts, activation rates unknown points, KC evidence changes mastery, or public read fabricates a score.
  it('无印规则 2/3 对：真实判分和结算不写 FSRS/掌握；公开 partial_unknown 携带 2/3、score=null', async () => {
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
    const n = normalizeQuestionRowToContract(row);
    const contract = d3aContract(n.group_id);
    const published = await publishQuestionGroup(db, {
      group_id: n.group_id,
      contract,
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
      actorRef: 'test:publish',
      now: NOW,
    });
    if (published.status !== 'published') throw new Error(`publish: ${published.status}`);

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

    const graded = await evaluateSubmission(db, {
      submission_id: submissionId,
      evaluation_group_id: groupId,
      evaluation_key: 'yuk1445_no_rule_partial',
    });
    expect(graded.record.aggregate).toMatchObject({
      kind: 'partial_unknown_points',
      known_points: 0,
      partial_units: [{ scoring_unit_id: 'u_match', correct_count: 2, total_count: 3 }],
    });

    const activation = await db.transaction((tx) =>
      activateEvaluation(
        tx,
        {
          evaluation_id: graded.record.evaluation_id,
          expected_effective_id: null,
          expected_generation: 0,
        },
        { settle: learningSettlement, actorRef: 'test', now: NOW },
      ),
    );
    expect(activation.status).toBe('activated');

    const receipts = await db
      .select()
      .from(event)
      .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payload).toMatchObject({
      rating: null,
      verdict: {
        verdict: 'unsupported',
        reason: 'partial_unknown_points',
        points: null,
        normalized: null,
      },
      theta_decision: { applied: false, abstainReason: 'no_kc_evidence' },
      kc_observations: [{ kc_id: KC, bit: 'abstain', basis: 'no_supported_evidence' }],
      effects: { fsrs_applied: [], theta_applied: [], family_observation_recorded: false },
    });
    expect(await db.select().from(material_fsrs_state)).toEqual([]);
    expect(await db.select().from(mastery_state)).toEqual([]);

    const effective = (await resolveVerdictForGroup(db, groupId)).effective;
    expect(effective?.evaluation_id).toBe(graded.record.evaluation_id);
    if (!effective?.scoring_basis) throw new Error('active evaluation has no frozen scoring basis');
    const judged = JudgeResultV2.parse(
      projectEvaluationToJudgeResult(
        EvaluationRecord.parse(effective.row),
        effective.scoring_basis,
      ),
    );
    expect(judged).toMatchObject({
      coarse_outcome: 'partial_unknown',
      score: null,
      partial_units: [{ scoring_unit_id: 'u_match', correct_count: 2, total_count: 3 }],
      feedback_md: '部分正确（2/3），分数未知',
    });
  });
});
