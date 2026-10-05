// YUK-1052 — deriveIssuanceBinding / scopeResponseSpec 纯单测（无 IO、无 DB）。
// 断言（grounding §3.1/§7.3）：
//   - 缺省 part_ids = 全部 parts；发出 part 实际引用的材料全部绑定且 digest
//     取 revision 冻结值；
//   - 缺省 option_order = 声明顺序（不 shuffle —— "以上都对"/引用字母选项保序）；
//   - 覆盖顺序必须是声明选项的排列，否则 validateIssuanceBinding 拒；
//   - 未发出 part 的材料/槽位不进绑定（部分发题不混入其它卷面）；
//   - scopeResponseSpec 只保留发出 part 的槽位（draft/submission 校验口径）。

import { describe, expect, it } from 'vitest';
import { scopeResponseSpec, validateResponseSet } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { deriveIssuanceBinding, validateIssuanceBinding } from './revision';

const REVISION: PublishedQuestionRevisionT = {
  revision_id: 'rev_1',
  group_id: 'g_1',
  revision_ordinal: 1,
  integrity_digest: 'sha256:digest1',
  structure: {
    group_id: 'g_1',
    materials: [
      {
        material_id: 'mat_passage',
        kind: 'passage',
        asset: { asset_id: 'asset_passage', digest: 'digest_passage_v1' },
        content_md: '阅读材料正文',
      },
      {
        material_id: 'mat_chart',
        kind: 'figure',
        asset: { asset_id: 'asset_chart', digest: 'digest_chart_v1' },
        alt_text: '图表',
      },
    ],
    parts: [
      { part_id: 'p1', prompt_md: '第1问', material_ids: ['mat_passage'] },
      { part_id: 'p2', prompt_md: '第2问', material_ids: ['mat_passage', 'mat_chart'] },
    ],
  },
  response_spec: {
    slots: [
      {
        slot_id: 'p1::choice',
        part_id: 'p1',
        kind: 'single_choice',
        options: [
          { option_id: 'o_a', label: 'A', text: '选项A' },
          { option_id: 'o_b', label: 'B', text: '选项B' },
          { option_id: 'o_c', label: 'C', text: '以上都对' },
        ],
      },
      {
        slot_id: 'p2::multi',
        part_id: 'p2',
        kind: 'multi_choice',
        options: [
          { option_id: 'm_a', label: 'A', text: '多选A' },
          { option_id: 'm_b', label: 'B', text: '多选B' },
        ],
        min_select: 1,
        max_select: 2,
      },
      { slot_id: 'p2::note', part_id: 'p2', kind: 'text', math_preview: false },
    ],
  },
  scoring_basis: {
    units: [
      {
        scoring_unit_id: 'u1',
        slot_refs: ['p1::choice'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: { kind: 'option_set_key', accepted_option_ids: ['o_a'] },
        points: 2,
      },
    ],
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  },
  execution_plan: {
    plan_version: 1,
    assignments: [
      {
        scoring_unit_ids: ['u1'],
        executor: { kind: 'deterministic', comparator: 'exact_option_set' },
      },
    ],
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
  },
  published_at: '2026-09-26T00:00:00.000Z',
  supersedes_revision_id: null,
};

describe('deriveIssuanceBinding', () => {
  it('default part_ids covers all parts and binds only referenced materials', () => {
    const binding = deriveIssuanceBinding(REVISION);
    expect(binding.revision_id).toBe('rev_1');
    expect(binding.part_ids).toEqual(['p1', 'p2']);
    // p1+p2 共同引用 mat_passage + mat_chart —— 都实际绑定，digest 取冻结值。
    expect(binding.material_bindings).toEqual([
      { material_id: 'mat_passage', asset_digest: 'digest_passage_v1' },
      { material_id: 'mat_chart', asset_digest: 'digest_chart_v1' },
    ]);
    expect(validateIssuanceBinding(binding, REVISION)).toEqual([]);
  });

  it('default option order preserves declared order (no shuffle)', () => {
    const binding = deriveIssuanceBinding(REVISION);
    expect(binding.option_order).toEqual([
      { slot_id: 'p1::choice', option_ids: ['o_a', 'o_b', 'o_c'] },
      { slot_id: 'p2::multi', option_ids: ['m_a', 'm_b'] },
    ]);
    // "以上都对"/引用字母选项保持原序 —— served order == declared order。
    expect(binding.option_order[0].option_ids[2]).toBe('o_c');
  });

  it('part subset issuance binds only that scope', () => {
    const binding = deriveIssuanceBinding(REVISION, { part_ids: ['p1'] });
    expect(binding.part_ids).toEqual(['p1']);
    // p1 只引用 mat_passage —— mat_chart 不进绑定。
    expect(binding.material_bindings).toEqual([
      { material_id: 'mat_passage', asset_digest: 'digest_passage_v1' },
    ]);
    expect(binding.option_order).toEqual([
      { slot_id: 'p1::choice', option_ids: ['o_a', 'o_b', 'o_c'] },
    ]);
    expect(validateIssuanceBinding(binding, REVISION)).toEqual([]);
  });

  it('option_order override must be a permutation of declared options', () => {
    const ok = deriveIssuanceBinding(REVISION, {
      part_ids: ['p1'],
      option_order_overrides: { 'p1::choice': ['o_b', 'o_c', 'o_a'] },
    });
    expect(validateIssuanceBinding(ok, REVISION)).toEqual([]);

    const bad = deriveIssuanceBinding(REVISION, {
      part_ids: ['p1'],
      option_order_overrides: { 'p1::choice': ['o_b', 'o_b', 'o_c'] },
    });
    const issues = validateIssuanceBinding(bad, REVISION);
    expect(issues.some((issue) => issue.code === 'option_order_not_permutation')).toBe(true);
  });

  it('unknown part / missing material surface as binding issues (fail-closed)', () => {
    const badPart = deriveIssuanceBinding(REVISION, { part_ids: ['p1', 'ghost'] });
    expect(validateIssuanceBinding(badPart, REVISION).some((i) => i.code === 'unknown_part')).toBe(
      true,
    );
  });
});

describe('scopeResponseSpec', () => {
  it('keeps only slots in the issued part scope', () => {
    const scoped = scopeResponseSpec(REVISION.response_spec, ['p1']);
    expect(scoped.slots.map((s) => s.slot_id)).toEqual(['p1::choice']);
  });

  it('response entries outside the issued scope are rejected by validateResponseSet', () => {
    const scoped = scopeResponseSpec(REVISION.response_spec, ['p1']);
    const issues = validateResponseSet(scoped, {
      entries: [
        { slot_id: 'p1::choice', kind: 'choice', option_ids: ['o_a'] },
        // p2::multi 未发出 —— 引用它是越界作答。
        { slot_id: 'p2::multi', kind: 'choice', option_ids: ['m_a'] },
      ],
    });
    expect(issues.some((i) => i.code === 'unknown_slot')).toBe(true);
  });
});
