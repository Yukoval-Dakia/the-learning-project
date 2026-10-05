// YUK-1046 — 跨层契约测试：一道【非学校题型枚举】的复合题走完五层 ——
// 结构 → 作答要求 → 评分依据 → 执行计划 → 判分记录，再经 issuance/feedback
// DTO 面向消费者。验收：通用复合结构、响应原语、开放作答/原始证据（D10）、
// 评分契约（scoring unit 引用 + 恰好一次聚合）全部可表达。

import { describe, expect, it } from 'vitest';
import { projectFeedback, projectPracticeIssuance } from './dto';
import { validateExecutionPlan } from './execution';
import {
  EvaluationRecord,
  type ScoringUnitResultT,
  SubmissionRecord,
  aggregateUnitResults,
} from './judgment';
import { validateResponseSet, validateResponseSpec } from './response';
import { AssessmentIssuance, PublishedQuestionRevision, validateIssuanceBinding } from './revision';
import { validateScoringBasis } from './scoring';
import { validateStructure } from './structure';

/**
 * 复合 fixture：共享阅读材料 + 图表；四个 part —— 6 选项多选、双空表格
 * （数值 + 文本）、配对、开放证明（D10 音频证据）；计分混合确定性键、
 * 数值键、规则引用与非加法整体等级（作文维度），聚合用 weighted_sum + cap。
 */
function compositeRevision() {
  return PublishedQuestionRevision.parse({
    revision_id: 'rev_42',
    group_id: 'grp_comp_1',
    revision_ordinal: 3,
    integrity_digest: 'sha256:composite',
    structure: {
      group_id: 'grp_comp_1',
      materials: [
        {
          material_id: 'mat_reading',
          kind: 'passage',
          asset: { asset_id: 'ast_reading', digest: 'sha256:reading' },
          caption: '阅读材料：楞次定律实验记录',
        },
        {
          material_id: 'mat_circuit',
          kind: 'figure',
          asset: { asset_id: 'ast_circuit', digest: 'sha256:circuit' },
          alt_text: '含二极管的 LC 振荡电路示意图',
        },
      ],
      parts: [
        {
          part_id: 'p_read',
          prompt_md: '阅读 mat_reading，回答下列小题。',
          question_no: '(一)',
          material_ids: ['mat_reading'],
        },
        {
          part_id: 'p_choice',
          prompt_md: '下列关于楞次定律的叙述，正确的有（多选）。',
          question_no: '(1)',
          material_ids: ['mat_reading'],
        },
        {
          part_id: 'p_blanks',
          prompt_md: '据 mat_circuit 完成表格。',
          question_no: '(2)',
          material_ids: ['mat_circuit'],
        },
        {
          part_id: 'p_proof',
          prompt_md: '结合实验音频证据，论述感应电流方向的判断依据。',
          question_no: '(3)',
          material_ids: [],
        },
      ],
    },
    response_spec: {
      slots: [
        {
          slot_id: 'mc',
          part_id: 'p_choice',
          kind: 'multi_choice',
          options: [
            { option_id: 'opt_a', label: 'A', text: '感应电流阻碍磁通量变化' },
            { option_id: 'opt_b', label: 'B', text: '感应电流与原磁场同向' },
            { option_id: 'opt_c', label: 'C', text: '楞次定律是能量守恒的体现' },
            { option_id: 'opt_d', label: 'D', text: '感应电流总是增大磁通量' },
            { option_id: 'opt_e', label: 'E', text: '感应电动势与磁通量变化率成正比' },
            { option_id: 'opt_f', label: 'F', text: '以上叙述全部错误' },
          ],
          min_select: 1,
          max_select: 4,
        },
        { slot_id: 'blank_period', part_id: 'p_blanks', kind: 'numeric', unit_hint: 'ms' },
        { slot_id: 'blank_reason', part_id: 'p_blanks', kind: 'text', math_preview: true },
        {
          slot_id: 'grid',
          part_id: 'p_blanks',
          kind: 'table',
          column_headers: ['物理量', '数值/结论'],
          row_labels: ['周期', '理由'],
          cells: [
            { row: 0, col: 1, slot_id: 'blank_period' },
            { row: 1, col: 1, slot_id: 'blank_reason' },
          ],
        },
        {
          slot_id: 'pair',
          part_id: 'p_blanks',
          kind: 'matching',
          left_items: [
            { item_id: 'case_1', label: '甲', text: '磁铁插入' },
            { item_id: 'case_2', label: '乙', text: '磁铁拔出' },
          ],
          right_options: [
            { option_id: 'dir_in', label: '①', text: '感应电流顺时针' },
            { option_id: 'dir_out', label: '②', text: '感应电流逆时针' },
          ],
        },
        {
          slot_id: 'essay',
          part_id: 'p_proof',
          kind: 'open_response',
          accepted_evidence: [
            {
              kind: 'audio',
              allowed_mime_patterns: ['audio/*'],
              max_bytes: 50_000_000,
              requires_security_scan: true,
            },
            {
              kind: 'plaintext',
              allowed_mime_patterns: ['text/plain'],
              max_bytes: 200_000,
              requires_security_scan: false,
            },
          ],
          evidence_required: true,
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'su_choice',
          slot_refs: ['mc'],
          material_refs: ['mat_reading'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['opt_a', 'opt_c', 'opt_e'] },
          points: 6,
        },
        {
          scoring_unit_id: 'su_period',
          slot_refs: ['blank_period'],
          material_refs: ['mat_circuit'],
          criterion: {
            kind: 'numeric_key',
            expected: 2.0,
            tolerance: { kind: 'relative', ratio: 0.05 },
            expected_unit: 'ms',
          },
          points: 4,
        },
        {
          scoring_unit_id: 'su_reason',
          slot_refs: ['blank_reason'],
          criterion: {
            kind: 'text_key',
            accepted_texts: ['自感', '自感现象'],
            normalization: 'trim_casefold_nfc',
          },
          points: 2,
        },
        {
          scoring_unit_id: 'su_pair',
          slot_refs: ['pair'],
          criterion: {
            // P1-8：配对题键显式编码左右映射，不能用 option 集合冒充。
            kind: 'matching_pairs_key',
            accepted_pairs: [
              { item_id: 'case_1', option_id: 'dir_in' },
              { item_id: 'case_2', option_id: 'dir_out' },
            ],
          },
          points: 2,
        },
        {
          scoring_unit_id: 'su_argument',
          slot_refs: ['essay'],
          material_refs: ['mat_reading'],
          evidence_slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              {
                level_id: 'lvl_full',
                descriptor_md: '论证完整：方向判断 + 阻碍叙述 + 实验印证',
                rank: 2,
              },
              { level_id: 'lvl_partial', descriptor_md: '论证基本完整，缺实验印证', rank: 1 },
              { level_id: 'lvl_weak', descriptor_md: '仅有结论无论证', rank: 0 },
            ],
          },
          // 非加法整体等级的显式映射；lvl_weak 有意未映射 —— 命中时不造总分。
          points: null,
          level_points: { lvl_full: 8, lvl_partial: 5 },
        },
      ],
      aggregation: { kind: 'capped_sum', cap: 20 },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 4,
      assignments: [
        {
          scoring_unit_ids: ['su_choice'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
        {
          scoring_unit_ids: ['su_pair'],
          executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
        },
        {
          scoring_unit_ids: ['su_period'],
          executor: { kind: 'deterministic', comparator: 'numeric_tolerance' },
        },
        {
          scoring_unit_ids: ['su_reason'],
          executor: { kind: 'deterministic', comparator: 'exact_text' },
        },
        {
          scoring_unit_ids: ['su_argument'],
          executor: {
            kind: 'model_executor',
            task_kind: 'judge/holistic_zh_v2',
            admitted_slice_id: 'slice_physics_essay_v1',
            max_cost_usd_micros: 60_000,
          },
        },
      ],
      escalation: { on_unadmitted_model: 'human_review', on_low_confidence: 'human_review' },
    },
    published_at: '2026-09-25T09:00:00.000Z',
    supersedes_revision_id: 'rev_41',
  });
}

describe('复合题全链路（五层模型 + DTO）', () => {
  const revision = compositeRevision();

  it('layers 1–4 all pass their deterministic validators', () => {
    expect(validateStructure(revision.structure)).toEqual([]);
    expect(validateResponseSpec(revision.response_spec)).toEqual([]);
    expect(
      validateScoringBasis(revision.scoring_basis, revision.response_spec, revision.structure),
    ).toEqual([]);
    expect(validateExecutionPlan(revision.execution_plan, revision.scoring_basis)).toEqual([]);
  });

  it('issuance binding is valid and the public DTO carries no scoring basis', () => {
    const issuance = AssessmentIssuance.parse({
      issuance_id: 'iss_comp_1',
      issued_at: '2026-09-25T09:05:00.000Z',
      binding: {
        revision_id: 'rev_42',
        part_ids: ['p_read', 'p_choice', 'p_blanks', 'p_proof'],
        material_bindings: [
          { material_id: 'mat_reading', asset_digest: 'sha256:reading' },
          { material_id: 'mat_circuit', asset_digest: 'sha256:circuit' },
        ],
        option_order: [
          { slot_id: 'mc', option_ids: ['opt_a', 'opt_b', 'opt_c', 'opt_d', 'opt_e', 'opt_f'] },
          { slot_id: 'pair', option_ids: ['dir_in', 'dir_out'] },
        ],
      },
      claim: { policy: 'one_time', status: 'claimed', claimed_by_ref: 'session:tutor_88' },
    });
    expect(validateIssuanceBinding(issuance.binding, revision)).toEqual([]);

    const dto = projectPracticeIssuance(revision, issuance);
    expect(dto.faces).toHaveLength(4);
    expect(dto.materials.map((material) => material.material_id).sort()).toEqual([
      'mat_circuit',
      'mat_reading',
    ]);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('scoring_basis');
    expect(serialized).not.toContain('accepted_option_ids');
    expect(serialized).not.toContain('admitted_slice_id');
  });

  it('P1-6: part-subset issuance restricts the projected slots to the issued scope', () => {
    const subset = AssessmentIssuance.parse({
      issuance_id: 'iss_comp_2',
      issued_at: '2026-09-25T09:06:00.000Z',
      binding: {
        revision_id: 'rev_42',
        part_ids: ['p_read', 'p_choice'], // 只发阅读 + 多选
        material_bindings: [{ material_id: 'mat_reading', asset_digest: 'sha256:reading' }],
        option_order: [
          { slot_id: 'mc', option_ids: ['opt_a', 'opt_b', 'opt_c', 'opt_d', 'opt_e', 'opt_f'] },
        ],
      },
      claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
    });
    expect(validateIssuanceBinding(subset.binding, revision)).toEqual([]);
    const dto = projectPracticeIssuance(revision, subset);
    expect(dto.faces.map((face) => face.part_id)).toEqual(['p_read', 'p_choice']);
    // 只有发出范围内的槽位进入公开 DTO；表格/配对/开放槽不泄漏。
    expect(dto.response_spec.slots.map((slot) => slot.slot_id)).toEqual(['mc']);
    expect(dto.materials.map((material) => material.material_id)).toEqual(['mat_reading']);

    // 跨 scope 的 option_order（引用未发出的配对槽）被拒绝。
    const crossScope = AssessmentIssuance.parse({
      ...subset,
      binding: {
        ...subset.binding,
        option_order: [
          ...subset.binding.option_order,
          { slot_id: 'pair', option_ids: ['dir_in', 'dir_out'] },
        ],
      },
    });
    expect(
      validateIssuanceBinding(crossScope.binding, revision).map((issue) => issue.code),
    ).toContain('option_order_slot_out_of_scope');
    expect(() => projectPracticeIssuance(revision, crossScope)).toThrow(
      /option_order_slot_out_of_scope/,
    );
  });

  it('submission → evaluation → single aggregation → visibility-gated feedback', () => {
    const submission = SubmissionRecord.parse({
      submission_id: 'sub_comp_1',
      issuance_id: 'iss_comp_1',
      revision_id: 'rev_42',
      evaluation_group_id: 'eg_comp_1',
      response_set: {
        entries: [
          { slot_id: 'mc', kind: 'choice', option_ids: ['opt_a', 'opt_c'] },
          { slot_id: 'blank_period', kind: 'numeric', value: 1.95, raw_input: '1.95' },
          { slot_id: 'blank_reason', kind: 'text', text_md: '自感' },
          {
            slot_id: 'pair',
            kind: 'matching',
            pairs: [
              { item_id: 'case_1', option_id: 'dir_in' },
              { item_id: 'case_2', option_id: 'dir_out' },
            ],
          },
          {
            slot_id: 'essay',
            kind: 'open',
            text_md: '由楞次定律，感应电流方向应阻碍磁通变化……（长文省略）',
            evidence: [
              {
                evidence_id: 'ev_audio',
                kind: 'audio',
                asset: { asset_id: 'ast_audio', digest: 'sha256:audio' },
                mime_type: 'audio/webm',
                bytes: 3_400_000,
                uploaded_at: '2026-09-25T09:20:00.000Z',
              },
            ],
          },
        ],
      },
      idempotency_key: 'idem-comp-1',
      submitted_at: '2026-09-25T09:22:00.000Z',
      // P1-6：整页照等 group 级证据的显式载体（声明式目标，不复制进槽位）。
      group_evidence: [
        {
          evidence: {
            evidence_id: 'ev_page',
            kind: 'image',
            asset: { asset_id: 'ast_page', digest: 'sha256:page' },
            mime_type: 'image/jpeg',
            bytes: 1_800_000,
            uploaded_at: '2026-09-25T09:21:00.000Z',
          },
          target: { scope: 'all_units' },
        },
      ],
    });
    expect(validateResponseSet(revision.response_spec, submission.response_set)).toEqual([]);

    const unitResults: ScoringUnitResultT[] = [
      {
        status: 'scored' as const,
        scoring_unit_id: 'su_choice',
        points_awarded: 4,
        scored_because: 'response' as const,
        matched: { option_ids: ['opt_a', 'opt_c'] },
        evidence_citations: [{ slot_id: 'mc' }],
      },
      {
        status: 'scored' as const,
        scoring_unit_id: 'su_period',
        points_awarded: 4,
        scored_because: 'response' as const,
        evidence_citations: [{ slot_id: 'blank_period' }],
      },
      {
        status: 'scored' as const,
        scoring_unit_id: 'su_reason',
        points_awarded: 2,
        scored_because: 'response' as const,
        evidence_citations: [{ slot_id: 'blank_reason' }],
      },
      {
        status: 'scored' as const,
        scoring_unit_id: 'su_pair',
        points_awarded: 2,
        scored_because: 'response' as const,
        evidence_citations: [{ slot_id: 'pair' }],
      },
      {
        status: 'scored' as const,
        scoring_unit_id: 'su_argument',
        points_awarded: null, // holistic：分数由发布侧 level_points 在聚合时解析
        scored_because: 'response' as const,
        matched: { level_id: 'lvl_partial', option_ids: [] },
        feedback_md: '方向判断正确，未引实验印证。',
        evidence_citations: [{ evidence_id: 'ev_audio' }],
      },
    ];
    // 4 + 4 + 2 + 2（加法）+ 5（lvl_partial 映射）= 17，未触 20 上限。
    const aggregate = aggregateUnitResults(revision.scoring_basis, unitResults);
    expect(aggregate).toEqual({
      kind: 'points_total',
      points: 17,
      policy: { kind: 'capped_sum', cap: 20 },
    });

    const evaluation = EvaluationRecord.parse({
      evaluation_id: 'ev_comp_1',
      evaluation_group_id: 'eg_comp_1',
      submission_id: 'sub_comp_1',
      attempt: 1,
      status: 'completed',
      unit_results: unitResults,
      aggregate,
      plan_digest: 'sha256:plan4',
      run_refs: ['task_run_301'],
      // D9/D16：模型执行器产出的自动判分（assisted=false）。
      provenance: { source: 'automatic', assisted: false },
    });

    const feedback = projectFeedback(submission, evaluation, revision, {
      reveal_total_score: true,
      reveal_unit_breakdown: true,
      reveal_answer_keys: true,
      reveal_rubric_explanations: true,
    });
    expect(feedback.aggregate).toEqual({ kind: 'points_total', points: 17 });
    expect(feedback.unit_results).toHaveLength(5);
    expect(
      feedback.unit_results.find((view) => view.scoring_unit_id === 'su_argument'),
    ).toMatchObject({
      status: 'scored',
      points_awarded: null,
    });
    expect(feedback.answer_keys.map((key) => key.criterion_kind)).toContain('holistic_level');
    expect(feedback.answer_keys.map((key) => key.criterion_kind)).toContain('matching_pairs_key');
    expect(feedback.rubric_explanations.map((item) => item.scoring_unit_id)).toEqual([
      'su_argument',
    ]);
  });

  it('evidence missing on an evidence_required open slot surfaces as pending, not zero', () => {
    const submission = SubmissionRecord.parse({
      submission_id: 'sub_comp_2',
      issuance_id: 'iss_comp_1',
      revision_id: 'rev_42',
      evaluation_group_id: 'eg_comp_2',
      response_set: {
        entries: [
          { slot_id: 'mc', kind: 'choice', option_ids: [] },
          { slot_id: 'essay', kind: 'open', text_md: '只有文字论述，未附音频证据' },
        ],
      },
      idempotency_key: 'idem-comp-2',
      submitted_at: '2026-09-25T09:30:00.000Z',
    });

    const unitResults: ScoringUnitResultT[] = [
      {
        status: 'pending' as const,
        scoring_unit_id: 'su_choice',
        pending: { reason: 'missing_response', slot_ids: ['blank_period', 'blank_reason', 'pair'] },
      },
      {
        status: 'pending' as const,
        scoring_unit_id: 'su_period',
        pending: { reason: 'missing_response', slot_ids: ['blank_period'] },
      },
      {
        status: 'pending' as const,
        scoring_unit_id: 'su_reason',
        pending: { reason: 'missing_response', slot_ids: ['blank_reason'] },
      },
      {
        status: 'pending' as const,
        scoring_unit_id: 'su_pair',
        pending: { reason: 'missing_response', slot_ids: ['pair'] },
      },
      {
        status: 'pending' as const,
        scoring_unit_id: 'su_argument',
        pending: {
          reason: 'insufficient_evidence',
          detail: 'evidence_required 槽未附任何 D10 证据',
        },
      },
    ];
    const aggregate = aggregateUnitResults(revision.scoring_basis, unitResults);
    expect(aggregate).toMatchObject({ kind: 'unresolved', reason: 'pending_units' });

    const evaluation = EvaluationRecord.parse({
      evaluation_id: 'ev_comp_2',
      evaluation_group_id: 'eg_comp_2',
      submission_id: 'sub_comp_2',
      attempt: 1,
      status: 'pending',
      unit_results: unitResults,
      aggregate: null,
    });
    const feedback = projectFeedback(submission, evaluation, revision, {
      reveal_total_score: true,
      reveal_unit_breakdown: true,
      reveal_answer_keys: true,
      reveal_rubric_explanations: true,
    });
    expect(feedback.status).toBe('pending');
    expect(feedback.aggregate).toBeNull();
  });
});
