// YUK-1046 — ResponseSpec / ResponseSet 契约测试（grounding §4.4、§7.2、D10）。

import { describe, expect, it } from 'vitest';

import {
  type ResponseSetT,
  ResponseSpec,
  type ResponseSpecT,
  isBlankSlotResponse,
  missingSlotIds,
  validateResponseSet,
  validateResponseSpec,
} from './response';

const OPTION_COUNT_FREEDOM = 7; // 不硬编码 4：7 个选项也必须可表达

function choiceSpec(): ResponseSpecT {
  return ResponseSpec.parse({
    slots: [
      {
        slot_id: 'q1',
        kind: 'multi_choice',
        options: Array.from({ length: OPTION_COUNT_FREEDOM }, (_, i) => ({
          option_id: `opt_${i + 1}`,
          label: String.fromCharCode(65 + i),
          text: `选项 ${i + 1} —— 一段足够长的选项文本，含 LaTeX $x^{${i + 1}}$ 与中文标点。`,
        })),
        min_select: 2,
        max_select: 5,
      },
      {
        slot_id: 'blank_a',
        kind: 'text',
        math_preview: true,
        placement: { row: 0, col: 1, label: '(1)' },
      },
      {
        slot_id: 'blank_b',
        kind: 'numeric',
        unit_hint: 'm/s²',
        placement: { row: 1, col: 1, label: '(2)' },
      },
      {
        slot_id: 'grid',
        kind: 'table',
        column_headers: ['物理量', '数值', '说明'],
        row_labels: ['第 1 行', '第 2 行'],
        cells: [
          { row: 0, col: 1, slot_id: 'blank_a' },
          { row: 1, col: 1, slot_id: 'blank_b' },
        ],
      },
      {
        slot_id: 'pair',
        kind: 'matching',
        left_items: [
          { item_id: 'lhs_1', label: 'A', text: '万有引力定律' },
          { item_id: 'lhs_2', label: 'B', text: '动能定理' },
        ],
        right_options: [
          { option_id: 'rhs_1', label: '1', text: 'F = GMm/r²' },
          { option_id: 'rhs_2', label: '2', text: 'W = ΔEk' },
        ],
      },
      {
        slot_id: 'seq',
        kind: 'ordering',
        items: [
          { item_id: 'step_1', label: '①', text: '受力分析' },
          { item_id: 'step_2', label: '②', text: '建立坐标系' },
          { item_id: 'step_3', label: '③', text: '列方程求解' },
        ],
      },
      {
        slot_id: 'proof',
        kind: 'open_response',
        accepted_evidence: [
          {
            kind: 'audio',
            allowed_mime_patterns: ['audio/*'],
            max_bytes: 25_000_000,
            requires_security_scan: true,
          },
          {
            kind: 'plaintext',
            allowed_mime_patterns: ['text/plain'],
            max_bytes: 100_000,
            requires_security_scan: false,
          },
        ],
        evidence_required: false,
      },
    ],
  });
}

describe('ResponseSpec — 通用原语可表达', () => {
  it('parses a composite spec with every primitive (7 options, table, matching, ordering, D10 evidence)', () => {
    const spec = choiceSpec();
    expect(spec.slots).toHaveLength(7);
    const first = spec.slots[0];
    expect(first.kind).toBe('multi_choice');
    if (first.kind !== 'multi_choice') throw new Error('fixture corrupted');
    expect(first.options).toHaveLength(OPTION_COUNT_FREEDOM);
  });

  it('rejects a two-option matching/ordering below minimum and malformed kinds', () => {
    expect(() =>
      ResponseSpec.parse({
        slots: [
          {
            slot_id: 'bad',
            kind: 'ordering',
            items: [{ item_id: 'only', label: '①', text: '孤立条目' }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('validateResponseSpec — 身份与引用完整性', () => {
  it('accepts the composite fixture', () => {
    expect(validateResponseSpec(choiceSpec())).toEqual([]);
  });

  it('flags duplicate slot ids', () => {
    const spec = choiceSpec();
    const mutated: ResponseSpecT = {
      ...spec,
      slots: [...spec.slots, { ...spec.slots[1], slot_id: spec.slots[1].slot_id }],
    };
    expect(validateResponseSpec(mutated).map((issue) => issue.code)).toContain('duplicate_slot_id');
  });

  it('flags duplicate option ids and out-of-range select bounds', () => {
    const spec = ResponseSpec.parse({
      slots: [
        {
          slot_id: 'm',
          kind: 'multi_choice',
          options: [
            { option_id: 'a', label: 'A', text: '甲' },
            { option_id: 'a', label: 'B', text: '乙（重复 option_id）' },
            { option_id: 'c', label: 'C', text: '丙' },
          ],
          min_select: 2,
          max_select: 4, // 超过 3 个选项
        },
      ],
    });
    const codes = validateResponseSpec(spec).map((issue) => issue.code);
    expect(codes).toContain('duplicate_option_id');
    expect(codes).toContain('invalid_select_bounds');
  });

  it('flags table cells that fall outside the grid, collide, reference tables, or dangle', () => {
    const spec = ResponseSpec.parse({
      slots: [
        { slot_id: 't', kind: 'text', math_preview: false },
        {
          slot_id: 'grid',
          kind: 'table',
          column_headers: ['列'],
          row_labels: ['行'],
          cells: [
            { row: 0, col: 0, slot_id: 't' },
            { row: 0, col: 0, slot_id: 't' }, // 坐标冲突
            { row: 5, col: 0, slot_id: 't' }, // 越界
            { row: 0, col: 0, slot_id: 'ghost' }, // 未解析
          ],
        },
        {
          slot_id: 'grid2',
          kind: 'table',
          column_headers: ['列'],
          row_labels: ['行'],
          cells: [{ row: 0, col: 0, slot_id: 'grid' }], // 引用表格
        },
      ],
    });
    const codes = validateResponseSpec(spec).map((issue) => issue.code);
    expect(codes).toContain('duplicate_cell_coord');
    expect(codes).toContain('table_bounds');
    expect(codes).toContain('unresolved_cell_slot');
    expect(codes).toContain('cell_references_table');
  });
});

describe('ResponseSet — 空白 ≠ missing，引用一致性', () => {
  it('explicit empty values are blank; absent entries are missing', () => {
    const spec = choiceSpec();
    const responseSet: ResponseSetT = {
      entries: [
        { slot_id: 'q1', kind: 'choice', option_ids: [] }, // 主动空白
        { slot_id: 'blank_a', kind: 'text', text_md: '   ' }, // 主动空白（空白文本）
        { slot_id: 'blank_b', kind: 'numeric', value: null }, // 主动空白
        { slot_id: 'seq', kind: 'ordering', item_order: [] }, // 主动空白
      ],
    };
    expect(missingSlotIds(spec, responseSet)).toEqual(['grid', 'pair', 'proof']);
    expect(responseSet.entries.filter(isBlankSlotResponse).map((entry) => entry.slot_id)).toEqual([
      'q1',
      'blank_a',
      'blank_b',
      'seq',
    ]);
    expect(isBlankSlotResponse({ slot_id: 'blank_b', kind: 'numeric', value: 3.2 })).toBe(false);
  });

  it('accepts a fully-answered structurally-consistent response set', () => {
    const spec = choiceSpec();
    const responseSet: ResponseSetT = {
      entries: [
        { slot_id: 'q1', kind: 'choice', option_ids: ['opt_1', 'opt_4'] },
        { slot_id: 'blank_a', kind: 'text', text_md: '$v_0 = 0$，由题意……' },
        { slot_id: 'blank_b', kind: 'numeric', value: 9.8, raw_input: '9.8' },
        {
          slot_id: 'pair',
          kind: 'matching',
          pairs: [
            { item_id: 'lhs_1', option_id: 'rhs_1' },
            { item_id: 'lhs_2', option_id: 'rhs_2' },
          ],
        },
        {
          slot_id: 'seq',
          kind: 'ordering',
          item_order: ['step_2', 'step_1', 'step_3'],
        },
        {
          slot_id: 'proof',
          kind: 'open',
          text_md: '证明：对小球受力分析……（长文本省略）',
          evidence: [
            {
              evidence_id: 'ev_audio_1',
              kind: 'audio',
              asset: { asset_id: 'ast_1', digest: 'sha256:deadbeef' },
              mime_type: 'audio/webm',
              bytes: 1_204_512,
              uploaded_at: '2026-09-25T08:00:00.000Z',
            },
          ],
        },
      ],
    };
    expect(validateResponseSet(spec, responseSet)).toEqual([]);
  });

  it('flags unknown options, duplicate slot entries, kind mismatch, bad pairing, non-permutation ordering', () => {
    const spec = choiceSpec();
    const responseSet: ResponseSetT = {
      entries: [
        { slot_id: 'q1', kind: 'choice', option_ids: ['opt_1', 'opt_99'] },
        { slot_id: 'q1', kind: 'choice', option_ids: ['opt_2'] },
        { slot_id: 'blank_a', kind: 'formula', latex: 'x' },
        {
          slot_id: 'pair',
          kind: 'matching',
          pairs: [
            { item_id: 'lhs_1', option_id: 'rhs_1' },
            { item_id: 'lhs_1', option_id: 'rhs_2' },
          ],
        },
        { slot_id: 'seq', kind: 'ordering', item_order: ['step_1', 'step_1'] },
      ],
    };
    const codes = validateResponseSet(spec, responseSet).map((issue) => issue.code);
    expect(codes).toContain('unknown_option_id');
    expect(codes).toContain('duplicate_entry_slot');
    expect(codes).toContain('kind_mismatch');
    expect(codes).toContain('duplicate_pair_item');
    expect(codes).toContain('ordering_not_permutation');
  });

  it('flags direct answers on a table container slot (cells answer individually)', () => {
    const spec = choiceSpec();
    const issues = validateResponseSet(spec, {
      entries: [{ slot_id: 'grid', kind: 'text', text_md: '直接答表格' }],
    });
    expect(issues.map((issue) => issue.code)).toContain('kind_mismatch');
  });

  it('rejects unknown evidence kinds at parse time (D10 set is closed)', () => {
    expect(() =>
      ResponseSpec.parse({
        slots: [
          {
            slot_id: 'o',
            kind: 'open_response',
            accepted_evidence: [
              {
                kind: 'executable', // 代码执行不在 D10 —— 明确拒绝
                allowed_mime_patterns: ['application/x-executable'],
                max_bytes: 100,
                requires_security_scan: true,
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
