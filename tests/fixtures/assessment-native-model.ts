import { createHash } from 'node:crypto';
import type { ModelExecutorRequest } from '@/core/schema/assessment';
export const assessmentDigest = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function nativeAssessmentFixture(): ModelExecutorRequest {
  const material = '|航段|路程|时间|\n|顺流|18km|1h|\n|逆流|12km|1h|';
  return {
    submission_id: 'sub-original',
    submission_ids: ['sub-original', 'sub-second'],
    evaluation_group_id: 'group',
    revision_id: 'rev-original',
    attempt: 2,
    scoring_unit_id: 'u1',
    executor: {
      kind: 'model_executor',
      task_kind: 'AssessmentRuleJudgeTask',
      admitted_slice_id: 'slice-approved',
      max_cost_usd_micros: 20_000,
    },
    unit: {
      scoring_unit_id: 'u1',
      slot_refs: ['s1'],
      evidence_slot_refs: [],
      material_refs: ['table'],
      requires_group_evidence: false,
      criterion: {
        kind: 'rule_reference',
        rule_id: 'r1',
        statement_md:
          '根据顺逆水航程建立方程并相加消去水速得静水速度15 km/h，完整过程5分；只建立两个正确方程得2分。',
        source: 'official',
      },
      points: 5,
    },
    question_parts: [
      {
        part_id: 'p1',
        prompt_md: '使用表格数据求船的静水速度。保留原始单位并写出方程。',
        material_ids: ['table'],
      },
    ],
    response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: true }],
    slot_responses: [
      { slot_id: 's1', kind: 'text', text_md: 'v+c=18，v-c=12，相加得2v=30，v=15 km/h。' },
    ],
    group_evidence: [],
    materials: [
      {
        material_id: 'table',
        kind: 'table',
        content_md: material,
        asset: { asset_id: 'table-asset', digest: assessmentDigest(material) },
      },
    ],
    spent_cost_usd_micros: 7_000,
  };
}
