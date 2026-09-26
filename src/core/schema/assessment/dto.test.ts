// YUK-1046 — 公私 DTO 边界契约测试（grounding §7.1）：
// issuance DTO 无答案键/私有 rubric/模型计划/未筛选 metadata；strict schema
// 让注入即失败；feedback DTO 按可见性 policy 揭示；编辑 DTO 是另一用途。

import { describe, expect, it } from 'vitest';

import {
  AssessmentFeedbackDto,
  type FeedbackVisibilityPolicyT,
  PracticeIssuanceDto,
  projectFeedback,
  projectPracticeIssuance,
} from './dto';
import {
  EvaluationRecord,
  type EvaluationRecordT,
  SubmissionRecord,
  type SubmissionRecordT,
} from './judgment';
import { validateResponseSpec } from './response';
import {
  AssessmentIssuance,
  type AssessmentIssuanceT,
  PublishedQuestionRevision,
  type PublishedQuestionRevisionT,
  validateIssuanceBinding,
} from './revision';

function revision(): PublishedQuestionRevisionT {
  return PublishedQuestionRevision.parse({
    revision_id: 'rev_7',
    group_id: 'grp_1',
    revision_ordinal: 7,
    integrity_digest: 'sha256:rev7',
    structure: {
      group_id: 'grp_1',
      materials: [
        {
          material_id: 'mat_fig',
          kind: 'figure',
          asset: { asset_id: 'ast_fig', digest: 'sha256:fig' },
          alt_text: '电路图：三个并联电阻',
        },
      ],
      parts: [
        {
          part_id: 'p1',
          prompt_md: '如图，求通过 R₁ 的电流。',
          material_ids: ['mat_fig'],
        },
      ],
    },
    response_spec: {
      slots: [
        {
          slot_id: 'mc',
          part_id: 'p1',
          kind: 'single_choice',
          options: [
            { option_id: 'o1', label: 'A', text: '0.5 A' },
            { option_id: 'o2', label: 'B', text: '1 A' },
            { option_id: 'o3', label: 'C', text: '2 A' },
          ],
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u_mc',
          slot_refs: ['mc'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['o2'] },
          points: 5,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u_mc'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'accept' },
    },
    published_at: '2026-09-25T07:00:00.000Z',
    supersedes_revision_id: null,
  });
}

function issuance(): AssessmentIssuanceT {
  return AssessmentIssuance.parse({
    issuance_id: 'iss_42',
    issued_at: '2026-09-25T07:30:00.000Z',
    binding: {
      revision_id: 'rev_7',
      part_ids: ['p1'],
      material_bindings: [{ material_id: 'mat_fig', asset_digest: 'sha256:fig' }],
      option_order: [{ slot_id: 'mc', option_ids: ['o1', 'o2', 'o3'] }],
    },
    claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
  });
}

describe('PracticeIssuanceDto — 公开面是 strict schema，不是渲染约定', () => {
  it('projects only public fields from a published revision + issuance', () => {
    const dto = projectPracticeIssuance(revision(), issuance());
    expect(dto.issuance_id).toBe('iss_42');
    expect(dto.revision_id).toBe('rev_7');
    expect(dto.faces).toHaveLength(1);
    expect(dto.materials).toHaveLength(1);
    expect(dto.response_spec.slots[0]).toMatchObject({ slot_id: 'mc', kind: 'single_choice' });
  });

  it('injected answer keys / rubric / execution plans / metadata fail parse', () => {
    const dto = projectPracticeIssuance(revision(), issuance());
    expect(() =>
      PracticeIssuanceDto.parse({ ...dto, answer_key: { accepted_option_ids: ['o2'] } }),
    ).toThrow();
    expect(() =>
      PracticeIssuanceDto.parse({ ...dto, rubric: { criteria: [{ name: 'x', weight: 1 }] } }),
    ).toThrow();
    expect(() =>
      PracticeIssuanceDto.parse({ ...dto, execution_plan: { assignments: [] } }),
    ).toThrow();
    expect(() =>
      PracticeIssuanceDto.parse({ ...dto, metadata: { internal_note: '易错题 2024' } }),
    ).toThrow();
    expect(() =>
      PracticeIssuanceDto.parse({ ...dto, scoring_basis: revision().scoring_basis }),
    ).toThrow();
  });

  it('the projection output contains no private material anywhere in its serialization', () => {
    const serialized = JSON.stringify(projectPracticeIssuance(revision(), issuance()));
    expect(serialized).not.toContain('accepted_option_ids');
    expect(serialized).not.toContain('scoring_basis');
    expect(serialized).not.toContain('execution_plan');
    expect(serialized).not.toContain('integrity_digest');
  });

  it('validateIssuanceBinding catches digest drift and unbound part materials', () => {
    const rev = revision();
    const stale = AssessmentIssuance.parse({
      ...issuance(),
      binding: {
        revision_id: 'rev_7',
        part_ids: ['p1'],
        material_bindings: [{ material_id: 'mat_fig', asset_digest: 'sha256:other' }],
        option_order: [{ slot_id: 'mc', option_ids: ['o1', 'o2', 'o3'] }],
      },
    });
    expect(validateIssuanceBinding(stale.binding, rev).map((issue) => issue.code)).toContain(
      'unknown_material_binding',
    );

    const unbound = AssessmentIssuance.parse({
      ...issuance(),
      binding: {
        revision_id: 'rev_7',
        part_ids: ['p1'],
        material_bindings: [],
        option_order: [{ slot_id: 'mc', option_ids: ['o1', 'o2', 'o3'] }],
      },
    });
    expect(validateIssuanceBinding(unbound.binding, rev).map((issue) => issue.code)).toContain(
      'unbound_part_material',
    );
  });

  it('served option order must be a permutation of the declared options (no shuffle by default)', () => {
    const shuffledSubset = AssessmentIssuance.parse({
      ...issuance(),
      binding: {
        revision_id: 'rev_7',
        part_ids: ['p1'],
        material_bindings: [{ material_id: 'mat_fig', asset_digest: 'sha256:fig' }],
        option_order: [{ slot_id: 'mc', option_ids: ['o1', 'o3'] }], // 丢了 o2
      },
    });
    expect(
      validateIssuanceBinding(shuffledSubset.binding, revision()).map((issue) => issue.code),
    ).toContain('option_order_not_permutation');
  });

  it('P1-2: an r1 binding validated against r2 is rejected — no silent revision drift', () => {
    const r1Binding = AssessmentIssuance.parse({
      ...issuance(),
      binding: { ...issuance().binding, revision_id: 'rev_6' },
    });
    const issues = validateIssuanceBinding(r1Binding.binding, revision());
    expect(issues.map((issue) => issue.code)).toEqual(['revision_mismatch']);
    // fail-closed：投影层直接抛错，绝不把 r2 冒充学生所见。
    expect(() => projectPracticeIssuance(revision(), r1Binding)).toThrow(/revision_mismatch/);
  });

  it('P1-2: projection reflects the FROZEN served option order, not the declared order', () => {
    const reversed = AssessmentIssuance.parse({
      ...issuance(),
      binding: {
        revision_id: 'rev_7',
        part_ids: ['p1'],
        material_bindings: [{ material_id: 'mat_fig', asset_digest: 'sha256:fig' }],
        option_order: [{ slot_id: 'mc', option_ids: ['o3', 'o2', 'o1'] }],
      },
    });
    expect(validateIssuanceBinding(reversed.binding, revision())).toEqual([]);
    const dto = projectPracticeIssuance(revision(), reversed);
    const slot = dto.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('fixture corrupted');
    expect(slot.options.map((option) => option.option_id)).toEqual(['o3', 'o2', 'o1']);

    // 默认（声明顺序）绑定：呈现与声明一致，不 shuffle。
    const dtoDefault = projectPracticeIssuance(revision(), issuance());
    const slotDefault = dtoDefault.response_spec.slots[0];
    if (slotDefault.kind !== 'single_choice') throw new Error('fixture corrupted');
    expect(slotDefault.options.map((option) => option.option_id)).toEqual(['o1', 'o2', 'o3']);
  });

  it('P1-2: any binding issue makes the projection fail closed', () => {
    const stale = AssessmentIssuance.parse({
      ...issuance(),
      binding: {
        revision_id: 'rev_7',
        part_ids: ['p1'],
        material_bindings: [{ material_id: 'mat_fig', asset_digest: 'sha256:stale' }],
        option_order: [{ slot_id: 'mc', option_ids: ['o1', 'o2', 'o3'] }],
      },
    });
    expect(validateIssuanceBinding(stale.binding, revision()).map((i) => i.code)).toContain(
      'unknown_material_binding',
    );
    expect(() => projectPracticeIssuance(revision(), stale)).toThrow(/unknown_material_binding/);
  });

  it('P1-B repro: cross-part table cell + part-subset issuance is rejected, never silently broken', () => {
    // 表格 t 在 p1，其单元格引用的 text 槽 s 在 p2；issuance 只选 p1。
    const crossPart = PublishedQuestionRevision.parse({
      ...revision(),
      structure: {
        group_id: 'grp_1',
        materials: [],
        parts: [
          { part_id: 'p1', prompt_md: '填表', material_ids: [] },
          { part_id: 'p2', prompt_md: '另一部分', material_ids: [] },
        ],
      },
      response_spec: {
        slots: [
          { slot_id: 's', part_id: 'p2', kind: 'text' },
          {
            slot_id: 't',
            part_id: 'p1',
            kind: 'table',
            column_headers: ['答案'],
            row_labels: ['行 1'],
            cells: [{ row: 0, col: 0, slot_id: 's' }], // 跨 part 单元格
          },
        ],
      },
    });
    const subset = AssessmentIssuance.parse({
      issuance_id: 'iss_subset',
      issued_at: '2026-09-25T10:00:00.000Z',
      binding: {
        revision_id: crossPart.revision_id,
        part_ids: ['p1'],
        material_bindings: [],
        option_order: [],
      },
      claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
    });

    // 1) spec 校验：单元格必须与表格同 part。
    expect(
      validateResponseSpec(crossPart.response_spec, crossPart.structure).map((i) => i.code),
    ).toContain('cell_part_scope_violation');
    // 2) binding 校验：发出表格的单元格不在发出范围。
    expect(validateIssuanceBinding(subset.binding, crossPart).map((i) => i.code)).toContain(
      'table_cell_out_of_scope',
    );
    // 3) 投影 fail-closed：绑定校验先行拦截（table_cell_out_of_scope），
    //    绝不产出引用不存在槽位的悬空表格；自检层作为深度防御保留。
    expect(() => projectPracticeIssuance(crossPart, subset)).toThrow(/table_cell_out_of_scope/);
  });
});

describe('AssessmentFeedbackDto — 按可见性 policy 揭示', () => {
  function records(): { submission: SubmissionRecordT; evaluation: EvaluationRecordT } {
    return {
      submission: SubmissionRecord.parse({
        submission_id: 'sub_9',
        issuance_id: 'iss_42',
        revision_id: 'rev_7',
        evaluation_group_id: 'eg_9',
        response_set: { entries: [{ slot_id: 'mc', kind: 'choice', option_ids: ['o2'] }] },
        idempotency_key: 'idem-9',
        submitted_at: '2026-09-25T08:00:00.000Z',
      }),
      evaluation: EvaluationRecord.parse({
        evaluation_id: 'ev_4',
        evaluation_group_id: 'eg_9',
        submission_id: 'sub_9',
        attempt: 1,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'u_mc',
            points_awarded: 5,
            scored_because: 'response',
            feedback_md: '选项 B 正确：I = U/R = 1 A。',
          },
        ],
        aggregate: { kind: 'points_total', points: 5, policy: { kind: 'sum' } },
      }),
    };
  }

  const allOff: FeedbackVisibilityPolicyT = {
    reveal_total_score: false,
    reveal_unit_breakdown: false,
    reveal_answer_keys: false,
    reveal_rubric_explanations: false,
  };

  it('reveals nothing when all flags are off (fields absent, not null/empty-as-revealed)', () => {
    const { submission, evaluation } = records();
    const dto = projectFeedback(submission, evaluation, revision(), allOff);
    expect(dto.status).toBe('completed');
    expect(dto.aggregate).toBeNull();
    expect(dto.unit_results).toEqual([]);
    expect(dto.answer_keys).toEqual([]);
    expect(dto.rubric_explanations).toEqual([]);
  });

  it('reveals each dimension independently', () => {
    const { submission, evaluation } = records();
    const rev = revision();

    const scoreOnly = projectFeedback(submission, evaluation, rev, {
      ...allOff,
      reveal_total_score: true,
    });
    expect(scoreOnly.aggregate).toMatchObject({ kind: 'points_total', points: 5 });
    expect(scoreOnly.unit_results).toEqual([]);

    const breakdownOnly = projectFeedback(submission, evaluation, rev, {
      ...allOff,
      reveal_unit_breakdown: true,
    });
    expect(breakdownOnly.aggregate).toBeNull();
    expect(breakdownOnly.unit_results).toHaveLength(1);
    expect(breakdownOnly.unit_results[0]).toMatchObject({
      scoring_unit_id: 'u_mc',
      status: 'scored',
      points_awarded: 5,
    });

    const keysOnly = projectFeedback(submission, evaluation, rev, {
      ...allOff,
      reveal_answer_keys: true,
    });
    expect(keysOnly.answer_keys).toEqual([
      {
        scoring_unit_id: 'u_mc',
        criterion_kind: 'option_set_key',
        accepted_option_ids: ['o2'],
      },
    ]);

    const rubricOnly = projectFeedback(submission, evaluation, rev, {
      ...allOff,
      reveal_rubric_explanations: true,
    });
    // option_set_key 无规则文本 —— 规则类 criterion 才有 rubric 揭示
    expect(rubricOnly.rubric_explanations).toEqual([]);
  });

  it('P1-3: answer keys expose rule/level IDENTITIES only — rubric text stays behind the rubric flag', () => {
    const { submission, evaluation } = records();
    const rev = revision();
    // 给 fixture 追加一个 rule_reference 单元和一个 holistic 单元（含私有描述符）。
    const withRubricUnits: typeof rev = {
      ...rev,
      scoring_basis: {
        ...rev.scoring_basis,
        units: [
          ...rev.scoring_basis.units,
          {
            scoring_unit_id: 'u_rule',
            slot_refs: ['mc'],
            material_refs: [],
            evidence_slot_refs: [],
            requires_group_evidence: false,
            criterion: {
              kind: 'rule_reference',
              rule_id: 'rule_secret_1',
              statement_md: '私有规则原文：答 B 且过程含欧姆定律推导给全分……',
              source: 'official',
            },
            points: 5,
          },
          {
            scoring_unit_id: 'u_level',
            slot_refs: ['mc'],
            material_refs: [],
            evidence_slot_refs: [],
            requires_group_evidence: false,
            criterion: {
              kind: 'holistic_level',
              levels: [
                { level_id: 'lvl_a', descriptor_md: '私有档位描述：论证完整', rank: 1 },
                { level_id: 'lvl_b', descriptor_md: '私有档位描述：论证不足', rank: 0 },
              ],
            },
            points: null,
          },
        ],
      },
    };

    const keysOnly = projectFeedback(submission, evaluation, withRubricUnits, {
      ...allOff,
      reveal_answer_keys: true,
    });
    const serializedKeys = JSON.stringify(keysOnly);
    expect(serializedKeys).not.toContain('statement_md');
    expect(serializedKeys).not.toContain('私有规则原文');
    expect(serializedKeys).not.toContain('descriptor_md');
    expect(serializedKeys).not.toContain('私有档位描述');
    const ruleKey = keysOnly.answer_keys.find((key) => key.criterion_kind === 'rule_reference');
    expect(ruleKey).toEqual({
      scoring_unit_id: 'u_rule',
      criterion_kind: 'rule_reference',
      rule_id: 'rule_secret_1',
    });
    const levelKey = keysOnly.answer_keys.find((key) => key.criterion_kind === 'holistic_level');
    expect(levelKey).toEqual({
      scoring_unit_id: 'u_level',
      criterion_kind: 'holistic_level',
      levels: [
        { level_id: 'lvl_a', rank: 1 },
        { level_id: 'lvl_b', rank: 0 },
      ],
    });
    expect(keysOnly.rubric_explanations).toEqual([]);

    const rubricOn = projectFeedback(submission, evaluation, withRubricUnits, {
      ...allOff,
      reveal_rubric_explanations: true,
    });
    const rubricText = rubricOn.rubric_explanations.map((item) => item.explanation_md).join('\n');
    expect(rubricText).toContain('私有规则原文');
    expect(rubricText).toContain('私有档位描述');
    // rubric 开、keys 关：键身份也不泄漏。
    expect(rubricOn.answer_keys).toEqual([]);
  });

  it('pending evaluation yields a status-only DTO regardless of flags', () => {
    const { submission } = records();
    const pending = EvaluationRecord.parse({
      evaluation_id: 'ev_5',
      evaluation_group_id: 'eg_9',
      submission_id: 'sub_9',
      attempt: 1,
      status: 'pending',
      unit_results: [],
      aggregate: null,
    });
    const dto = projectFeedback(submission, pending, revision(), {
      reveal_total_score: true,
      reveal_unit_breakdown: true,
      reveal_answer_keys: true,
      reveal_rubric_explanations: true,
    });
    expect(dto.status).toBe('pending');
    expect(dto.aggregate).toBeNull();
    expect(dto.answer_keys).toEqual([]);
  });

  it('feedback DTO is strict too — private plan leakage fails parse', () => {
    const { submission, evaluation } = records();
    const dto = projectFeedback(submission, evaluation, revision(), {
      ...allOff,
      reveal_total_score: true,
    });
    expect(() =>
      AssessmentFeedbackDto.parse({ ...dto, execution_plan: { assignments: [] } }),
    ).toThrow();
  });

  it("YUK-1096 P1-1: stale/mis-keyed lookups throw coded errors — never another record's feedback", () => {
    const { submission, evaluation } = records();

    // evaluation 属于另一份 submission（stale cache / 错键 lookup）。
    const foreignEvaluation = EvaluationRecord.parse({
      ...evaluation,
      submission_id: 'sub_other',
    });
    expect(() => projectFeedback(submission, foreignEvaluation, revision(), allOff)).toThrow(
      /evaluation_submission_mismatch/,
    );

    // evaluation 属于另一个判分组（同 submission_id 但组身份不一致）。
    const foreignGroup = EvaluationRecord.parse({
      ...evaluation,
      evaluation_group_id: 'eg_other',
    });
    expect(() => projectFeedback(submission, foreignGroup, revision(), allOff)).toThrow(
      /evaluation_group_mismatch/,
    );

    // submission 冻结的 revision 与传入题面不一致（陈旧题面）。
    const staleRevision = PublishedQuestionRevision.parse({
      ...revision(),
      revision_id: 'rev_8',
    });
    expect(() => projectFeedback(submission, evaluation, staleRevision, allOff)).toThrow(
      /submission_revision_mismatch/,
    );

    // 连贯输入仍然投影成功（防御不破坏主路径）。
    const ok = projectFeedback(submission, evaluation, revision(), allOff);
    expect(ok.submission_id).toBe('sub_9');
  });
});
