// YUK-1043 — contract-normalizer 纯单测（无 IO；unit 分区）。
// 身份纪律（§3.1）与契约可发布性是核心被测不变量；复审 P1-2/P1-3 补齐：
// 保真（stem/rubric/per-part 答案/provenance/digest 覆盖）、多答案键
// （multi_choice）、未决转换（conversion_issues）。

import { createHash } from 'node:crypto';
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

describe('第二轮复审 P1-2/P1-3 — 保真与身份（先红后绿）', () => {
  it('P1-2a: shared stem material carries its BYTES (content_md) — the immutable revision can recover the passage', () => {
    const tree = {
      id: 'stem_x',
      role: 'stem',
      prompt_text: '阅读下面的文言文，完成后面小题。（共享长文本……）',
      sub_questions: [
        { id: 'leaf_x', role: 'sub', prompt_text: '(1) 解释加点词', answers: ['趁机'] },
      ],
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ structured: tree, choices_md: null, reference_md: '趁机' }),
    );
    const stem = n.structure.materials.find((m) => m.caption === 'stem/shared context');
    if (!stem) throw new Error('stem material missing');
    // 字节随 revision 内联持久化（content_md），不是只有 txt_<hash> 引用 ——
    // 共享段落可从不可变 revision 自恢复（含 stem 文本；row prompt 若与 stem
    // 不同文则一并内联）。
    expect((stem as { content_md?: string }).content_md).toContain(
      '阅读下面的文言文，完成后面小题。（共享长文本……）',
    );
    expect(stem.asset.digest).toBe(
      `sha256:${createHash('sha256')
        .update((stem as { content_md: string }).content_md)
        .digest('hex')}`,
    );
  });

  it('P1-2a: rubric material carries its bytes too', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({ rubric_json: { criteria: [{ id: 'c1', points: 2, desc: '论点' }] } }),
    );
    const rubricMat = n.structure.materials.find((m) => m.caption?.startsWith('rubric'));
    if (!rubricMat) throw new Error('rubric material missing');
    expect((rubricMat as { content_md?: string }).content_md).toContain('论点');
  });

  it('P1-2b: structured leaf WITHOUT its own answer is unresolved — root reference must NOT become its key', () => {
    const tree = {
      id: 'stem_y',
      role: 'stem',
      prompt_text: 'stem',
      sub_questions: [
        { id: 'leaf_y', role: 'sub', prompt_text: '(1) 求值' }, // 无 answers
      ],
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ structured: tree, choices_md: null, reference_md: 'B' }),
    );
    expect(n.conversion_issues).toHaveLength(1);
    expect(n.conversion_issues[0]).toMatchObject({ code: 'missing_reference', partId: 'leaf_y' });
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    // 未决：placeholder 文本，不是 root 的答案键。
    expect(unit.criterion.statement_md).toContain('待补规则');
    expect(unit.criterion.statement_md).not.toContain('（判分意图');
  });

  it('P1-2c: AI-backfilled answer (rubric.reference_solution_source=ai_generated) is system_proposed even on a web_sourced row', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({
        kind: 'short_answer',
        choices_md: null,
        reference_md: 'AI 生成的 worked solution',
        rubric_json: {
          criteria: [],
          reference_solution: { final_answer: '42' },
          reference_solution_source: 'ai_generated',
        },
        source: 'web_sourced',
      }),
    );
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.source).toBe('system_proposed'); // D1 —— 答案证据来源，不是题目获取来源
  });

  it('YUK-1099 #3 (owner ruling B): standalone leaf WITHOUT answers falls back to row reference_md — numeric head mints text_key', () => {
    // import/auto-enroll 形状：structured 是 standalone 单叶（无 answers），
    // 行级 reference_md 是真实答案 —— 不得 missing_reference 丢弃。
    const tree = {
      id: 'solo_num',
      role: 'standalone',
      prompt_text: '1 + 2 = ?',
      // answers 缺省
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ kind: 'short_answer', structured: tree, choices_md: null, reference_md: '3' }),
    );
    expect(n.conversion_issues).toEqual([]); // 答案有 ⇒ 不 withheld
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'text_key') {
      throw new Error(`expected text_key, got ${unit.criterion.kind}`);
    }
    expect(unit.criterion.accepted_texts).toEqual(['3']);
    expect(n.execution_plan.assignments[0].executor).toEqual({
      kind: 'deterministic',
      comparator: 'exact_text',
    });
  });

  it('YUK-1099 #3: standalone leaf WITHOUT answers + letter reference_md on a choice slot mints option_set_key', () => {
    const tree = {
      id: 'solo_choice',
      role: 'standalone',
      prompt_text: '选出正确项',
      options: [
        { label: 'A', text: '选项一' },
        { label: 'B', text: '选项二' },
        { label: 'C', text: '选项三' },
      ],
      // answers 缺省 —— 行 reference 兜底
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ kind: 'choice', structured: tree, choices_md: null, reference_md: 'B' }),
    );
    expect(n.conversion_issues).toEqual([]);
    const slot = n.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected single_choice');
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'option_set_key') {
      throw new Error(`expected option_set_key, got ${unit.criterion.kind}`);
    }
    expect(unit.criterion.accepted_option_ids).toEqual([slot.options[1].option_id]); // B
    expect(n.execution_plan.assignments[0].executor).toEqual({
      kind: 'deterministic',
      comparator: 'exact_option_set',
    });
  });

  it('YUK-1099 #3: standalone leaf WITHOUT answers and NO/unparseable reference_md stays withheld — never silently fake', () => {
    const tree = {
      id: 'solo_none',
      role: 'standalone',
      prompt_text: '简答',
    } as unknown as StructuredQuestionT;
    // 无 reference_md
    const missing = normalizeQuestionRowToContract(
      baseRow({ kind: 'short_answer', structured: tree, choices_md: null, reference_md: null }),
    );
    expect(missing.conversion_issues).toHaveLength(1);
    expect(missing.conversion_issues[0]).toMatchObject({
      code: 'missing_reference',
      partId: 'solo_none',
    });

    // 选择槽 + 不在选项内的字母 ⇒ 未决转换（unrepresentable_answer），不伪造键。
    const choiceTree = {
      id: 'solo_bad',
      role: 'standalone',
      prompt_text: '选出正确项',
      options: [
        { label: 'A', text: '一' },
        { label: 'B', text: '二' },
      ],
    } as unknown as StructuredQuestionT;
    const unparseable = normalizeQuestionRowToContract(
      baseRow({ kind: 'choice', structured: choiceTree, choices_md: null, reference_md: 'Z' }),
    );
    expect(unparseable.conversion_issues).toHaveLength(1);
    expect(unparseable.conversion_issues[0].code).toBe('unrepresentable_answer');
    expect(unparseable.conversion_issues[0].partId).toBe('solo_bad');
    const unit = unparseable.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') {
      throw new Error('unparseable reference must not mint an option key');
    }
  });

  it('YUK-1099 #3: standalone leaf with only BLANK answers counts as "no answers" — row reference_md still drives the key (gate/mapping parity)', () => {
    // [`]` 与 `[]` 同为「无答案」：standalone 门与答案映射用同一判据，
    // 不得门放行兜底而映射仍发空白答案。
    const tree = {
      id: 'solo_blank',
      role: 'standalone',
      prompt_text: '1 + 2 = ?',
      answers: [''], // 显式空白 —— 等价于缺省
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ kind: 'short_answer', structured: tree, choices_md: null, reference_md: '3' }),
    );
    expect(n.conversion_issues).toEqual([]);
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'text_key') {
      throw new Error(`expected text_key, got ${unit.criterion.kind}`);
    }
    expect(unit.criterion.accepted_texts).toEqual(['3']);
  });

  it('YUK-1099 #3 scope: non-standalone (stem+subs) leaf without answers does NOT inherit root reference — P1-2b unchanged', () => {
    const tree = {
      id: 'stem_nr',
      role: 'stem',
      prompt_text: 'stem',
      sub_questions: [
        { id: 'leaf_nr', role: 'sub', prompt_text: '(1)' }, // 无 answers
      ],
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(
      baseRow({ structured: tree, choices_md: null, reference_md: 'B' }),
    );
    expect(n.conversion_issues).toHaveLength(1);
    expect(n.conversion_issues[0]).toMatchObject({ code: 'missing_reference', partId: 'leaf_nr' });
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.statement_md).not.toBe('B');
  });

  it('P1-2c: physical part carries its OWN structured options and figures through the publisher projection', () => {
    const root = baseRow({
      id: 'grp_c',
      kind: 'composite',
      prompt_md: 'stem',
      choices_md: null,
      figures: [
        {
          asset_id: 'ast_root',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, w: 1, h: 1 },
          attached_to_index: 'grp_c',
          attach_confidence: 'high',
        } as unknown as FigureRefT,
      ],
    });
    const n = normalizeQuestionGroupToContract(root, [
      {
        id: 'p1',
        prompt_md: '(1)',
        reference_md: 'A',
        choices_md: ['错误', '正确'],
        structured: {
          id: 'p1',
          role: 'standalone',
          prompt_text: '(1)',
          answers: ['B'],
          options: [
            { label: 'A', text: '选项甲' },
            { label: 'B', text: '选项乙' },
          ],
        } as unknown as StructuredQuestionT,
        figures: [
          {
            asset_id: 'ast_part',
            role: 'diagram',
            source_page_index: 0,
            source_bbox: { x: 0, y: 0, w: 1, h: 1 },
            attached_to_index: 'p1',
            attach_confidence: 'high',
          } as unknown as FigureRefT,
        ],
      },
    ]);
    // 选项来自 part 自己的 structured（叶 options），不是行级 choices。
    const slot = n.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected single_choice');
    expect(slot.options.map((o) => o.text)).toEqual(['选项甲', '选项乙']);
    // part 图与 root 图都进材料（各自内容寻址身份，part 引用两者）。
    const assetIds = n.structure.materials.map((m) => m.asset.asset_id);
    expect(assetIds).toContain('ast_part');
    expect(assetIds).toContain('ast_root');
    expect(n.structure.parts[0].material_ids).toHaveLength(3); // stem + root figure + part figure
  });

  it('YUK-1099 #2: physical part prompt derives from its edited structured leaf, not the stale prompt_md column', () => {
    const root = baseRow({ id: 'grp_p', kind: 'composite', prompt_md: 'stem', choices_md: null });
    const partStructured = (text: string) =>
      ({
        id: 'p1',
        role: 'standalone',
        prompt_text: text,
        answers: ['42'],
      }) as unknown as StructuredQuestionT;
    const parts = (text: string) => [
      {
        id: 'p1',
        prompt_md: '(1) 旧题面', // 编辑走 structured；flat 列不追更
        reference_md: '42',
        choices_md: null,
        structured: partStructured(text),
      },
    ];
    const before = normalizeQuestionGroupToContract(root, parts('(1) 旧题面'));
    const after = normalizeQuestionGroupToContract(root, parts('(1) 已修订的题面'));
    // prompt 以 structured 叶文本为准（edit_node_text 的落点）。
    expect(after.structure.parts[0].prompt_md).toBe('(1) 已修订的题面');
    // 且实质变化必须反映进 digest —— 否则 publisher digest-noop 漏铸新 revision。
    expect(after.integrity_digest).not.toBe(before.integrity_digest);
  });

  it('YUK-1099 #2 fallback: part WITHOUT structured keeps the row prompt_md', () => {
    const root = baseRow({ id: 'grp_q', kind: 'composite', prompt_md: 'stem', choices_md: null });
    const n = normalizeQuestionGroupToContract(root, [
      { id: 'p1', prompt_md: '(1) flat prompt', reference_md: '42', choices_md: null },
    ]);
    expect(n.structure.parts[0].prompt_md).toBe('(1) flat prompt');
  });

  it('P1-3: option identity is TEXT-only — label-only change keeps the option id and the digest', () => {
    // mintOptionId 无 label 入参：label 是显示元数据，不是身份输入。
    //（同文本 ⇒ 同 id；异文本 ⇒ 新身份；disambiguator 仅用于同槽重复文本消歧。）
    expect(mintOptionId('text')).toBe(mintOptionId('text'));
    expect(mintOptionId('text')).not.toBe(mintOptionId('text2'));
    expect(mintOptionId('text')).not.toBe(mintOptionId('text', '#2'));

    // structured 选项 relabel（A/B → 甲/乙，文本不变）⇒ 同 option id、同 digest。
    const relabel = (labelA: string, labelB: string) =>
      ({
        id: 'solo_z',
        role: 'standalone',
        prompt_text: '选词填空',
        answers: ['B'],
        options: [
          { label: labelA, text: '选项甲' },
          { label: labelB, text: '选项乙' },
        ],
      }) as unknown as StructuredQuestionT;
    const a = normalizeQuestionRowToContract(
      baseRow({ structured: relabel('A', 'B'), choices_md: null }),
    );
    const b = normalizeQuestionRowToContract(
      baseRow({ structured: relabel('甲', '乙'), choices_md: null }),
    );
    const slotA = a.response_spec.slots[0];
    const slotB = b.response_spec.slots[0];
    if (slotA.kind !== 'single_choice' || slotB.kind !== 'single_choice') {
      throw new Error('expected single_choice');
    }
    expect(slotB.options.map((o) => o.option_id)).toEqual(slotA.options.map((o) => o.option_id));
    expect(b.integrity_digest).toBe(a.integrity_digest);
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
