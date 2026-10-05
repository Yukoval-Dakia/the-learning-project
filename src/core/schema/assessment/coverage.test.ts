import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CAPABILITY_COVERAGE_MATRIX,
  EVIDENCE_KINDS,
  PENDING_REASONS,
  RESPONSE_SLOT_KINDS,
  coverageFor,
} from './coverage';
import { DeterministicComparatorId, ExecutorDescriptor } from './execution';
import {
  ADMISSION_VERIFICATION_OUTCOME,
  ISSUANCE_CLAIM_POLICY,
  LEGACY_DRAFT_STATUS,
  MARKING_RULE_PROVENANCE,
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
  SUSPENSION_REASON,
  isLegacyPoolVisibleStatus,
} from './lifecycle';
import { EvidenceKind } from './materials';
import { PendingState } from './pending';
import { LifecycleQualification, MarkingRuleProvenance, ScoringAdmission } from './publish';
import { ResponseSpec } from './response';

// ====================================================================
// YUK-1056 — constants/枚举覆盖审计的 unit pin（grounding §15）
// ====================================================================
//
// 断言方向：constants ↔ 契约 schema 的一致性 + 矩阵完备性。
// 任何 enum 扩张（新 slot kind / withheld reason / pending reason）没有同步
// 常量与覆盖矩阵 → 红。这就是「常量化」的防漂移钉。

const validSlotFor: Record<(typeof RESPONSE_SLOT_KINDS)[number], object> = {
  single_choice: {
    slot_id: 's',
    part_id: 'p',
    options: [
      { option_id: 'a', label: 'A', text: 'x' },
      { option_id: 'b', label: 'B', text: 'y' },
    ],
  },
  multi_choice: {
    slot_id: 's',
    part_id: 'p',
    options: [
      { option_id: 'a', label: 'A', text: 'x' },
      { option_id: 'b', label: 'B', text: 'y' },
    ],
    min_select: 1,
    max_select: 2,
  },
  text: { slot_id: 's', part_id: 'p' },
  numeric: { slot_id: 's', part_id: 'p' },
  formula: { slot_id: 's', part_id: 'p', notation: 'latex' },
  table: {
    slot_id: 's',
    part_id: 'p',
    column_headers: ['c'],
    row_labels: ['r'],
    cells: [{ row: 0, col: 0, slot_id: 's' }],
  },
  matching: {
    slot_id: 's',
    part_id: 'p',
    left_items: [
      { item_id: 'l1', label: '1', text: 'x' },
      { item_id: 'l2', label: '2', text: 'y' },
    ],
    right_options: [
      { option_id: 'r1', label: 'A', text: 'x' },
      { option_id: 'r2', label: 'B', text: 'y' },
    ],
  },
  ordering: {
    slot_id: 's',
    part_id: 'p',
    items: [
      { item_id: 'i1', label: '1', text: 'x' },
      { item_id: 'i2', label: '2', text: 'y' },
    ],
  },
  open_response: { slot_id: 's', part_id: 'p' },
};

describe('response primitive 枚举覆盖', () => {
  it('每一个 slot kind 有矩阵行 + 契约可 parse（expressible 是真断言，不是自述）', () => {
    expect(CAPABILITY_COVERAGE_MATRIX.map((r) => r.slot_kind).sort()).toEqual(
      [...RESPONSE_SLOT_KINDS].sort(),
    );
    for (const row of CAPABILITY_COVERAGE_MATRIX) {
      // ResponseSpec schema 校验该 kind 至少存在（expressible）。
      const spec = ResponseSpec.parse({
        slots: [{ kind: row.slot_kind, ...validSlotFor[row.slot_kind] }],
      });
      expect(spec.slots[0].kind).toBe(row.slot_kind);
      expect(row.expressible).toBe('covered');
    }
  });

  it('确定性比较器只在对应原语上声明（不得虚构能力）', () => {
    const withComparator = CAPABILITY_COVERAGE_MATRIX.filter(
      (r) => r.deterministic_comparator !== null,
    );
    for (const row of withComparator) {
      expect(row.auto_scorable).toBe('deterministic');
      // 比较器 id 必须存在于 contract 枚举。
      DeterministicComparatorId.parse(row.deterministic_comparator);
    }
    // 无比较器原语诚实标注 model_unadmitted/container。
    for (const row of CAPABILITY_COVERAGE_MATRIX) {
      if (row.deterministic_comparator === null) {
        expect(['model_unadmitted', 'container']).toContain(row.auto_scorable);
      }
    }
  });

  it('manual_evidence_required ⇒ auto_scorable 非 deterministic（诚实化）', () => {
    for (const row of CAPABILITY_COVERAGE_MATRIX) {
      if (row.manual_evidence_required) {
        expect(row.auto_scorable).not.toBe('deterministic');
        ExecutorDescriptor.parse({ kind: 'human_review' }); // 人工通道契约存在
      }
    }
  });

  it('evidence kind 与 PendingState reason 词表来自 schema（单源）', () => {
    expect([...EVIDENCE_KINDS]).toEqual([...EvidenceKind.options]);
    const reasons = PendingState.options.map((o) => o.shape.reason.value);
    expect([...PENDING_REASONS]).toEqual(reasons);
  });
});

describe('draft_status 拆分常量', () => {
  it('LEGACY_DRAFT_STATUS 覆盖既有词表（NULL≡active 语义不变）', () => {
    expect(LEGACY_DRAFT_STATUS.DRAFT).toBe('draft');
    expect(LEGACY_DRAFT_STATUS.ACTIVE).toBe('active');
    expect(isLegacyPoolVisibleStatus(null)).toBe(true);
    expect(isLegacyPoolVisibleStatus('active')).toBe(true);
    expect(isLegacyPoolVisibleStatus('draft')).toBe(false);
    // 历史哨兵值照旧 fail-open（'final' 等）。
    expect(isLegacyPoolVisibleStatus('final')).toBe(true);
  });

  it('生命周期词表与 publish/zod 契约逐字一致', () => {
    // availability：schema enum 是断言真相源。
    const parsedAvail = LifecycleQualification.parse({
      has_published_revision: true,
      scoring_admission: { state: 'withheld', reason: 'unverified_rules' },
      availability: 'container_only',
      suspension: { suspended: false, reason: null },
      withdrawal: { withdrawn: false, withdrawn_at: null },
    });
    expect(parsedAvail.availability).toBe(QUESTION_AVAILABILITY.CONTAINER_ONLY);
    expect(z.enum(['general_pool', 'container_only']).options).toEqual([
      QUESTION_AVAILABILITY.GENERAL_POOL,
      QUESTION_AVAILABILITY.CONTAINER_ONLY,
    ]);
    // admission state + withheld reason：discriminated union 全分支覆盖。
    expect(
      ScoringAdmission.parse({
        state: SCORING_ADMISSION_STATE.WITHHELD,
        reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
      }).state,
    ).toBe('withheld');
    for (const reason of [
      'unverified_rules',
      'verification_failed',
      'no_admitted_executor',
      'owner_hold',
    ]) {
      expect(
        Object.values(SCORING_ADMISSION_WITHHELD_REASON).includes(
          reason as (typeof SCORING_ADMISSION_WITHHELD_REASON)[keyof typeof SCORING_ADMISSION_WITHHELD_REASON],
        ),
      ).toBe(true);
    }
    expect(MarkingRuleProvenance.options).toEqual([
      MARKING_RULE_PROVENANCE.OFFICIAL,
      MARKING_RULE_PROVENANCE.SYSTEM_VERIFIED,
      MARKING_RULE_PROVENANCE.MANUAL,
    ]);
  });

  it('claim/suspension/outcome 词表常量化（写路径断言即契约）', () => {
    expect(Object.values(ISSUANCE_CLAIM_POLICY)).toEqual(['one_time', 'unbounded']);
    expect(Object.values(SUSPENSION_REASON)).toEqual(['verify_hold', 'retraction_hold']);
    expect(Object.values(ADMISSION_VERIFICATION_OUTCOME)).toEqual([
      'passed',
      'suspended',
      'failed',
    ]);
  });

  it('coverageFor 兜底：契约扩张缺行即可见（不失联）', () => {
    for (const kind of RESPONSE_SLOT_KINDS) {
      expect(coverageFor(kind)).toBeDefined();
    }
  });
});
