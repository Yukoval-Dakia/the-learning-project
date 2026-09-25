// YUK-1043 — contract-normalizer 纯单测（无 IO；unit 分区）。
// 身份纪律（§3.1）与契约可发布性是核心被测不变量；复审 P1-2/P1-3 补齐：
// 保真（stem/rubric/per-part 答案/provenance/digest 覆盖）、多答案键
// （multi_choice）、未决转换（conversion_issues）。

import { describe, expect, it } from 'vitest';

import {
  validateExecutionPlan,
  validateResponseSpec,
  validateScoringBasis,
} from '@/core/schema/assessment';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import {
  type NormalizableQuestionRow,
  mintOptionId,
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from './contract-normalizer';

function baseRow(overrides: Partial<NormalizableQuestionRow> = {}): NormalizableQuestionRow {
  return {
    id: 'q1',
    kind: 'choice',
    prompt_md: '下列说法正确的是',
    reference_md: 'B',
    rubric_json: null,
    choices_md: ['甲', '乙', '丙'],
    judge_kind_override: null,
    structured: null,
    parent_question_id: null,
    source: 'web_sourced',
    figures: null,
    ...overrides,
  };
}

function expectValidContract(n: ReturnType<typeof normalizeQuestionRowToContract>) {
  expect(validateResponseSpec(n.response_spec, n.structure)).toEqual([]);
  expect(validateScoringBasis(n.scoring_basis, n.response_spec, n.structure)).toEqual([]);
  expect(validateExecutionPlan(n.execution_plan, n.scoring_basis)).toEqual([]);
}

describe('normalizeQuestionRowToContract — 契约四层可发布', () => {
  it('produces a contract that passes all three deterministic validators', () => {
    const n = normalizeQuestionRowToContract(baseRow());
    expectValidContract(n);
    expect(n.integrity_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(n.group_id).toBe('q1');
    expect(n.conversion_issues).toEqual([]);
  });

  it('single question = 1-part group: part_id = question.id, slot derived from it', () => {
    const n = normalizeQuestionRowToContract(baseRow());
    expect(n.structure.parts).toHaveLength(1);
    expect(n.structure.parts[0].part_id).toBe('q1');
    expect(n.response_spec.slots[0].slot_id).toBe('q1::r');
    expect(n.response_spec.slots[0].part_id).toBe('q1');
  });

  it('single-letter head → single_choice + option_set_key + exact_option_set', () => {
    const n = normalizeQuestionRowToContract(baseRow({ reference_md: 'B' }));
    const slot = n.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected single_choice');
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'option_set_key') throw new Error('expected option_set_key');
    expect(unit.criterion.accepted_option_ids).toEqual([slot.options[1].option_id]);
    expect(n.execution_plan.assignments[0].executor).toEqual({
      kind: 'deterministic',
      comparator: 'exact_option_set',
    });
  });

  it('P1-3: multi-letter head (AC) → multi_choice slot + option_set_key of 2 — a valid multi-answer is representable', () => {
    const n = normalizeQuestionRowToContract(baseRow({ reference_md: 'AC' }));
    const slot = n.response_spec.slots[0];
    if (slot.kind !== 'multi_choice') {
      throw new Error(`expected multi_choice, got ${slot.kind}`);
    }
    expect(slot.min_select).toBe(1);
    expect(slot.max_select).toBe(3);
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'option_set_key') throw new Error('expected option_set_key');
    expect(unit.criterion.accepted_option_ids).toEqual([
      slot.options[0].option_id,
      slot.options[2].option_id,
    ]);
    expectValidContract(n);
    expect(n.execution_plan.assignments[0].executor).toEqual({
      kind: 'deterministic',
      comparator: 'exact_option_set',
    });
    for (const ref of ['A C', 'A,C', 'a、c']) {
      const m = normalizeQuestionRowToContract(baseRow({ reference_md: ref }));
      const s = m.response_spec.slots[0];
      if (s.kind !== 'multi_choice') throw new Error(`expected multi_choice for ${ref}`);
      expect(m.scoring_basis.units[0].criterion).toMatchObject({ kind: 'option_set_key' });
    }
  });

  it('P1-3: unrepresentable head (letter beyond options / prose on a choice row) → rule_reference (no invented key)', () => {
    const n = normalizeQuestionRowToContract(baseRow({ reference_md: 'K' }));
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(n.execution_plan.assignments[0].executor).toEqual({ kind: 'human_review' });
  });

  it('P1-2: text slot + explicit exact judge + exact-capable reference → deterministic text_key (legacy exact semantic)', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({
        kind: 'short_answer',
        choices_md: null,
        reference_md: '42',
        judge_kind_override: 'exact',
      }),
    );
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'text_key') throw new Error('expected text_key');
    expect(unit.criterion.accepted_texts).toEqual(['42']);
    expect(unit.criterion.normalization).toBe('trim');
    expect(n.execution_plan.assignments[0].executor).toEqual({
      kind: 'deterministic',
      comparator: 'exact_text',
    });
  });

  it('P1-2: rule_reference provenance maps the ACTUAL answer origin — web_sourced→official, quiz_gen→system_proposed, manual→manual', () => {
    for (const [source, expected] of [
      ['web_sourced', 'official'],
      ['quiz_gen', 'system_proposed'],
      ['dreaming', 'system_proposed'],
      ['manual', 'manual'],
    ] as const) {
      const n = normalizeQuestionRowToContract(
        baseRow({
          kind: 'computation',
          choices_md: null,
          reference_md: '解：由动能定理……',
          judge_kind_override: 'semantic',
          source,
        }),
      );
      const unit = n.scoring_basis.units[0];
      if (unit.criterion.kind !== 'rule_reference') throw new Error(`expected rule for ${source}`);
      expect(unit.criterion.source, `source=${source}`).toBe(expected);
      expect(unit.criterion.statement_md).toContain('动能定理');
    }
  });

  it('P1-2: missing reference (no rubric) → conversion issue + placeholder is NEVER official', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({ kind: 'short_answer', choices_md: null, reference_md: null, source: 'quiz_gen' }),
    );
    expect(n.conversion_issues).toHaveLength(1);
    expect(n.conversion_issues[0]).toMatchObject({ code: 'missing_reference', partId: 'q1' });
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.source).toBe('system_proposed');
    expect(unit.criterion.statement_md).toContain('待补规则');
    expectValidContract(n);
  });

  it('P1-2: rubric-only row keeps the rubric as the rule text (provenance not official)', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({
        kind: 'essay',
        choices_md: null,
        reference_md: null,
        rubric_json: { criteria: [{ id: 'c1', points: 2, desc: '论点明确' }] },
        source: 'web_sourced',
      }),
    );
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.statement_md).toContain('论点明确');
    // reference 缺失 ⇒ 即使行来自 web_sourced，rubric 是管线结构化产物 ⇒ 不标 official。
    expect(unit.criterion.source).toBe('system_proposed');
    expect(n.conversion_issues).toHaveLength(1);
  });

  it('P1-2: rubric participates in digest — same reference, different rubric ⇒ different digest', () => {
    const a = normalizeQuestionRowToContract(baseRow({ rubric_json: { criteria: [] } }));
    const b = normalizeQuestionRowToContract(
      baseRow({ rubric_json: { criteria: [{ id: 'c1', points: 1, desc: 'x' }] } }),
    );
    expect(a.integrity_digest).not.toBe(b.integrity_digest);
  });

  it('P1-2: judge_kind_override participates in digest on rule_reference rows', () => {
    const a = normalizeQuestionRowToContract(
      baseRow({ kind: 'essay', choices_md: null, judge_kind_override: 'keyword' }),
    );
    const b = normalizeQuestionRowToContract(
      baseRow({ kind: 'essay', choices_md: null, judge_kind_override: 'semantic' }),
    );
    expect(a.integrity_digest).not.toBe(b.integrity_digest);
  });

  it('P1-2: figures become shared materials with content-addressed identity; part references them', () => {
    const figures = [
      {
        asset_id: 'ast_fig1',
        role: 'diagram',
        source_page_index: 0,
        source_bbox: { x: 0, y: 0, w: 10, h: 10 },
        attached_to_index: 'q1',
        attach_confidence: 'high',
      },
    ] as unknown as FigureRefT[];
    const n = normalizeQuestionRowToContract(baseRow({ figures }));
    expect(n.structure.materials).toHaveLength(1);
    expect(n.structure.materials[0].kind).toBe('figure');
    expect(n.structure.materials[0].asset.asset_id).toBe('ast_fig1');
    expect(n.structure.parts[0].material_ids).toEqual([n.structure.materials[0].material_id]);
    expectValidContract(n);
  });
});

describe('structured 树归一（P1-2 保真）', () => {
  const tree = (): StructuredQuestionT =>
    ({
      id: 'stem_1',
      role: 'stem',
      prompt_text: '阅读下文，回答 (1)(2)。',
      sub_questions: [
        { id: 'node_a', role: 'sub', prompt_text: '(1) 求周期', answers: ['2ms'] },
        {
          id: 'node_b',
          role: 'sub',
          prompt_text: '(2) 选出正确项',
          options: [
            { label: 'A', text: '选项一' },
            { label: 'B', text: '选项二' },
          ],
          answers: ['B'],
        },
      ],
    }) as unknown as StructuredQuestionT;

  it('leaf node ids become part identities; stem prompt becomes a shared plaintext material', () => {
    const n = normalizeQuestionRowToContract(baseRow({ structured: tree(), choices_md: null }));
    expect(n.structure.parts.map((p) => p.part_id)).toEqual(['node_a', 'node_b']);
    expect(n.structure.materials).toHaveLength(1);
    expect(n.structure.materials[0].kind).toBe('plaintext');
    expect(n.structure.materials[0].asset.digest).toMatch(/^sha256:/);
    expect(n.structure.parts.every((p) => p.material_ids.length === 1)).toBe(true);
    expectValidContract(n);
  });

  it('P1-2 regression: leaf answers win over the row reference — leaf B answers B while root reference says A', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({ structured: tree(), choices_md: null, reference_md: 'A' }),
    );
    const slotB = n.response_spec.slots.find((s) => s.part_id === 'node_b');
    if (slotB?.kind !== 'single_choice') throw new Error('expected node_b single_choice');
    const unitB = n.scoring_basis.units.find((u) => u.scoring_unit_id === 'node_b::u');
    if (unitB?.criterion.kind !== 'option_set_key') {
      throw new Error('expected option_set_key for node_b');
    }
    expect(unitB.criterion.accepted_option_ids).toEqual([slotB.options[1].option_id]); // B，不是 A
    const slotA = n.response_spec.slots.find((s) => s.part_id === 'node_a');
    if (slotA?.kind !== 'text') throw new Error('expected node_a text');
    const unitA = n.scoring_basis.units.find((u) => u.scoring_unit_id === 'node_a::u');
    if (unitA?.criterion.kind !== 'rule_reference') {
      // 无显式 exact 判分意图时保守 rule_reference + human_review（D17）；
      // P1-2 回归点：叶 answers 作为规则原文（不是 root 的 reference A）。
      throw new Error(`expected rule_reference for node_a, got ${unitA?.criterion.kind}`);
    }
    expect(unitA.criterion.statement_md).toContain('2ms');
  });

  it('P1-2: node_b options come from the tree node, not the row choices; digest covers stem text', () => {
    const n1 = normalizeQuestionRowToContract(baseRow({ structured: tree(), choices_md: null }));
    const slotB = n1.response_spec.slots.find((s) => s.part_id === 'node_b');
    if (slotB?.kind !== 'single_choice') throw new Error('expected single_choice');
    expect(slotB.options.map((o) => o.text)).toEqual(['选项一', '选项二']);

    const editedTree = tree();
    (editedTree as { prompt_text: string }).prompt_text = '阅读下文（修订版），回答 (1)(2)。';
    const n2 = normalizeQuestionRowToContract(
      baseRow({ structured: editedTree, choices_md: null }),
    );
    expect(n2.integrity_digest).not.toBe(n1.integrity_digest); // stem 变 ⇒ digest 变
  });
});

describe('物理多 part 组归一（P1-2 保真）', () => {
  it('root prompt becomes shared material referenced by every part; per-part references drive keys', () => {
    const root = baseRow({
      id: 'grp',
      kind: 'composite',
      prompt_md: '阅读材料，完成下列小题。',
      reference_md: 'A', // root 的 reference 是 stem 级信息 —— 不摊派给 part
      choices_md: null,
      structured: null,
    });
    const n = normalizeQuestionGroupToContract(root, [
      { id: 'p1', prompt_md: '(1) 求值', reference_md: '42', choices_md: null },
      {
        id: 'p2',
        prompt_md: '(2) 选出正确项',
        reference_md: 'B',
        choices_md: ['甲', '乙'],
      },
    ]);
    expect(n.group_id).toBe('grp');
    expect(n.structure.materials).toHaveLength(1);
    expect(n.structure.materials[0].kind).toBe('plaintext');
    expect(n.structure.parts.map((p) => p.part_id)).toEqual(['p1', 'p2']);
    expect(n.structure.parts.every((p) => p.material_ids.length === 1)).toBe(true);
    const unitP2 = n.scoring_basis.units.find((u) => u.scoring_unit_id === 'p2::u');
    if (unitP2?.criterion.kind !== 'option_set_key') {
      throw new Error('expected p2 option_set_key from ITS OWN reference');
    }
    expectValidContract(n);
  });

  it('P1-2 regression: part without its own reference is UNRESOLVED — root reference must NOT become its answer key', () => {
    const root = baseRow({
      id: 'grp2',
      kind: 'composite',
      prompt_md: 'stem',
      reference_md: 'B',
      choices_md: null,
    });
    const n = normalizeQuestionGroupToContract(root, [
      { id: 'p1', prompt_md: '(1)', reference_md: null, choices_md: null },
    ]);
    expect(n.conversion_issues).toHaveLength(1);
    expect(n.conversion_issues[0]).toMatchObject({ code: 'missing_reference', partId: 'p1' });
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.source).not.toBe('official');
  });

  it('P1-2: changing the composite ROOT prompt changes the digest (stem is authoritative input)', () => {
    const root = (prompt: string) =>
      baseRow({ id: 'grp3', kind: 'composite', prompt_md: prompt, choices_md: null });
    const a = normalizeQuestionGroupToContract(root('旧题干'), [
      { id: 'p1', prompt_md: '(1)', reference_md: '42', choices_md: null },
    ]);
    const b = normalizeQuestionGroupToContract(root('新题干'), [
      { id: 'p1', prompt_md: '(1)', reference_md: '42', choices_md: null },
    ]);
    expect(a.integrity_digest).not.toBe(b.integrity_digest);
  });
});

describe('身份纪律（§3.1）', () => {
  it('semantic-identical republish keeps part/slot/option identities and digest', () => {
    const first = normalizeQuestionRowToContract(baseRow());
    const second = normalizeQuestionRowToContract(baseRow());
    expect(second.structure.parts[0].part_id).toBe(first.structure.parts[0].part_id);
    expect(second.response_spec.slots[0].slot_id).toBe(first.response_spec.slots[0].slot_id);
    expect(second.integrity_digest).toBe(first.integrity_digest);
  });

  it('option text edit mints a NEW option id for the edited option only (semantic replacement)', () => {
    const before = normalizeQuestionRowToContract(baseRow());
    const after = normalizeQuestionRowToContract(baseRow({ choices_md: ['甲', '乙（改）', '丙'] }));
    const slotBefore = before.response_spec.slots[0];
    const slotAfter = after.response_spec.slots[0];
    if (slotBefore.kind !== 'single_choice' || slotAfter.kind !== 'single_choice') {
      throw new Error('expected single_choice');
    }
    expect(slotAfter.options[0].option_id).toBe(slotBefore.options[0].option_id); // 未变选项保留
    expect(slotAfter.options[2].option_id).toBe(slotBefore.options[2].option_id);
    expect(slotAfter.options[1].option_id).not.toBe(slotBefore.options[1].option_id); // 改写 ⇒ 新身份
    expect(after.integrity_digest).not.toBe(before.integrity_digest);
  });

  it('structured node id preserved ⇒ slot/part identity survives pure-text edit of the prompt', () => {
    const tree = (id: string) =>
      ({
        id: 'leaf_1',
        role: 'standalone',
        prompt_text: id,
        answers: ['x'],
      }) as unknown as StructuredQuestionT;
    const a = normalizeQuestionRowToContract(baseRow({ structured: tree('旧题面') }));
    const b = normalizeQuestionRowToContract(baseRow({ structured: tree('新题面') }));
    expect(b.structure.parts[0].part_id).toBe(a.structure.parts[0].part_id); // node id 保留
    expect(b.response_spec.slots[0].slot_id).toBe(a.response_spec.slots[0].slot_id);
    expect(b.integrity_digest).not.toBe(a.integrity_digest); // 但内容 digest 变了 → 新版本
  });

  it('mintOptionId is content-addressed: stable for identical content, distinct for different', () => {
    expect(mintOptionId('A', 'text')).toBe(mintOptionId('A', 'text'));
    expect(mintOptionId('A', 'text')).not.toBe(mintOptionId('A', 'text '));
    expect(mintOptionId('A', 'text')).not.toBe(mintOptionId('B', 'text'));
  });
});
