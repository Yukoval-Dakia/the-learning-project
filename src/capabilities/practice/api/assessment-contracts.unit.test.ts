// YUK-1091 — assessment wire 契约与 core AssessmentIssuance 的对齐钉桩：
// createIssuance / getIssuance 返回嵌套 `binding` 的 AssessmentIssuanceT；
// 恢复快照补回 practice_dto + admission_generation_observed。

import { describe, expect, it } from 'vitest';

import { IssuanceCreatedSchema, IssuanceStateSchema } from './assessment-contracts';

const ISSUED_AT = '2026-09-26T00:00:00.000Z';

const nestedIssuance = {
  issuance_id: 'iss_1',
  binding: {
    revision_id: 'rev_1',
    part_ids: ['part_1'],
    material_bindings: [],
    option_order: [{ slot_id: 'slot_1', option_ids: ['o1', 'o2'] }],
  },
  issued_at: ISSUED_AT,
  claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
};

const practiceDto = {
  issuance_id: 'iss_1',
  revision_id: 'rev_1',
  issued_at: ISSUED_AT,
  faces: [{ part_id: 'part_1', prompt_md: '题面', material_ids: [] }],
  materials: [],
  response_spec: {
    slots: [{ slot_id: 'slot_1', part_id: 'part_1', kind: 'text' }],
  },
};

describe('assessment issuance wire contracts (YUK-1091)', () => {
  it('IssuanceCreatedSchema accepts the nested-binding core issuance shape', () => {
    const parsed = IssuanceCreatedSchema.parse({
      status: 'issued',
      issuance: nestedIssuance,
      practice_dto: practiceDto,
      admission_generation_observed: 3,
    });
    expect(parsed.issuance.binding.revision_id).toBe('rev_1');
    expect(parsed.issuance.binding.option_order).toEqual([
      { slot_id: 'slot_1', option_ids: ['o1', 'o2'] },
    ]);
    // 平铺字段不属于 wire 形状（core 类型真相源）。
    expect('container_occurrence_ref' in parsed.issuance).toBe(false);
    expect('revision_id' in parsed.issuance).toBe(false);
  });

  it('rejects the legacy flat-coordinate issuance shape (missing binding)', () => {
    const flat = {
      status: 'issued',
      issuance: {
        issuance_id: 'iss_1',
        revision_id: 'rev_1',
        part_ids: ['part_1'],
        material_bindings: [],
        option_order: [],
        container_occurrence_ref: null,
        issued_at: ISSUED_AT,
        claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
      },
      practice_dto: practiceDto,
      admission_generation_observed: null,
    };
    expect(IssuanceCreatedSchema.safeParse(flat).success).toBe(false);
  });

  it('IssuanceStateSchema carries practice_dto + admission_generation_observed for recovery', () => {
    const parsed = IssuanceStateSchema.parse({
      issuance: nestedIssuance,
      practice_dto: practiceDto,
      admission_generation_observed: 7,
      draft: null,
      submissions: [],
    });
    expect(parsed.practice_dto?.faces).toHaveLength(1);
    expect(parsed.admission_generation_observed).toBe(7);

    // 未发题/已知为空时两字段如实为 null。
    const empty = IssuanceStateSchema.parse({
      issuance: null,
      practice_dto: null,
      admission_generation_observed: null,
      draft: null,
      submissions: [],
    });
    expect(empty.practice_dto).toBeNull();
  });
});
