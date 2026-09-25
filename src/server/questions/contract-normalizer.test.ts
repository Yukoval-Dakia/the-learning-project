// YUK-1043 — contract-normalizer 纯单测（无 IO；unit 分区）。
// 身份纪律（§3.1）与契约可发布性是核心被测不变量。

import { describe, expect, it } from 'vitest';

import {
  validateExecutionPlan,
  validateResponseSpec,
  validateScoringBasis,
} from '@/core/schema/assessment';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  type NormalizableQuestionRow,
  mintOptionId,
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
    ...overrides,
  };
}

describe('normalizeQuestionRowToContract — 契约四层可发布', () => {
  it('produces a contract that passes all three deterministic validators', () => {
    const n = normalizeQuestionRowToContract(baseRow());
    expect(validateResponseSpec(n.response_spec, n.structure)).toEqual([]);
    expect(validateScoringBasis(n.scoring_basis, n.response_spec, n.structure)).toEqual([]);
    expect(validateExecutionPlan(n.execution_plan, n.scoring_basis)).toEqual([]);
    expect(n.integrity_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(n.group_id).toBe('q1');
  });

  it('single question = 1-part group: part_id = question.id, slot derived from it', () => {
    const n = normalizeQuestionRowToContract(baseRow());
    expect(n.structure.parts).toHaveLength(1);
    expect(n.structure.parts[0].part_id).toBe('q1');
    expect(n.response_spec.slots[0].slot_id).toBe('q1::r');
    expect(n.response_spec.slots[0].part_id).toBe('q1');
  });

  it('choice row → single_choice slot + option_set_key from reference head letters', () => {
    const n = normalizeQuestionRowToContract(baseRow({ reference_md: 'AC' }));
    const slot = n.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('expected single_choice');
    expect(slot.options).toHaveLength(3); // 数量不硬编码：3 个选项就是 3 个
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'option_set_key') throw new Error('expected option_set_key');
    expect(unit.criterion.accepted_option_ids).toEqual([
      slot.options[0].option_id,
      slot.options[2].option_id,
    ]);
    expect(unit.points).toBe(1);
    // exact 判分可确定性执行。
    const assign = n.execution_plan.assignments[0];
    expect(assign.executor).toEqual({ kind: 'deterministic', comparator: 'exact_option_set' });
  });

  it('non-choice / unparseable reference → rule_reference + human_review executor', () => {
    const n = normalizeQuestionRowToContract(
      baseRow({
        kind: 'computation',
        choices_md: null,
        reference_md: '解：由动能定理……（长解答）',
        judge_kind_override: 'semantic',
      }),
    );
    const unit = n.scoring_basis.units[0];
    if (unit.criterion.kind !== 'rule_reference') throw new Error('expected rule_reference');
    expect(unit.criterion.statement_md).toContain('动能定理');
    expect(unit.criterion.source).toBe('official');
    expect(n.execution_plan.assignments[0].executor).toEqual({ kind: 'human_review' });
  });

  it('structured tree: leaf node ids become part identities (multi-leaf group)', () => {
    const tree = {
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
          answers: ['A'],
        },
      ],
    } as unknown as StructuredQuestionT;
    const n = normalizeQuestionRowToContract(baseRow({ structured: tree, choices_md: null }));
    expect(n.structure.parts.map((p) => p.part_id)).toEqual(['node_a', 'node_b']);
    // node_b 的选项来自树节点而非行级 choices。
    const slotB = n.response_spec.slots.find((s) => s.part_id === 'node_b');
    if (slotB?.kind !== 'single_choice') throw new Error('expected node_b single_choice');
    expect(slotB.options.map((o) => o.text)).toEqual(['选项一', '选项二']);
    expect(n.scoring_basis.units).toHaveLength(2);
  });
});

describe('身份纪律（§3.1）', () => {
  it('semantic-identical republish keeps part/slot/option identities and digest', () => {
    const first = normalizeQuestionRowToContract(baseRow());
    const second = normalizeQuestionRowToContract(baseRow({ difficulty: 4 } as never));
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

describe('参考答案头解析', () => {
  it('parses separated/multi-letter heads (AC / A C / A,C)', () => {
    for (const ref of ['AC', 'A C', 'A,C', 'a、c']) {
      const n = normalizeQuestionRowToContract(baseRow({ reference_md: ref }));
      const unit = n.scoring_basis.units[0];
      if (unit.criterion.kind !== 'option_set_key') {
        throw new Error(`expected option_set_key for ${ref}`);
      }
      expect(unit.criterion.accepted_option_ids).toHaveLength(2);
    }
  });

  it('unparseable head (letter beyond option count / prose) falls back to rule_reference', () => {
    const n = normalizeQuestionRowToContract(baseRow({ reference_md: 'K' }));
    expect(n.scoring_basis.units[0].criterion.kind).toBe('rule_reference');
  });
});
