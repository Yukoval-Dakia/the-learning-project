// YUK-1046 — 发布 policy 契约测试：D1 自动准入/withheld、draft_status 语义拆分。

import { describe, expect, it } from 'vitest';

import {
  AdmissionVerificationRecord,
  LifecycleQualification,
  PublishDecision,
  ScoringAdmission,
} from './publish';

describe('ScoringAdmission — D1：核验后自动准入，未解决 withheld', () => {
  it('system_verified provenance is explicitly NOT official', () => {
    const admitted = ScoringAdmission.parse({
      state: 'admitted',
      evidence: {
        marking_provenance: 'system_verified',
        verification: {
          structural_check_passed: true,
          independent_verification: {
            passed: true,
            verifier: 'independent_model',
            verified_at: '2026-09-25T06:00:00.000Z',
          },
        },
        model_slice: {
          slice_id: 'slice_choice_zh_v1',
          holdout_cases: 35,
          severe_errors_observed: 0,
          per_criterion_agreement: 0.97,
          pipeline_coverage: 0.96,
        },
      },
      admitted_at: '2026-09-25T06:05:00.000Z',
      generation: 2,
    });
    expect(admitted.state).toBe('admitted');
    if (admitted.state === 'admitted') {
      expect(admitted.evidence.marking_provenance).not.toBe('official');
      expect(admitted.evidence.model_slice?.holdout_cases).toBeGreaterThanOrEqual(30); // D17
    }
  });

  it('unverified rules stay withheld — never auto-admitted', () => {
    const withheld = ScoringAdmission.parse({
      state: 'withheld',
      reason: 'unverified_rules',
      detail: '第二模型同意但结构校验未过 —— 同意本身不构成证明',
    });
    expect(withheld.state).toBe('withheld');
  });

  it('rejects unknown withheld reasons (closed enum)', () => {
    expect(() => ScoringAdmission.parse({ state: 'withheld', reason: 'vibes' })).toThrow();
  });
});

describe('AdmissionVerificationRecord — §3.3 新式 verify 载荷', () => {
  it('records revision digest + versioned policy + generation', () => {
    const record = AdmissionVerificationRecord.parse({
      revision_id: 'rev_7',
      revision_digest: 'sha256:rev7',
      policy_id: 'admission-policy@2026-09-24',
      generation: 3,
      outcome: 'passed',
      recorded_at: '2026-09-25T06:10:00.000Z',
    });
    expect(record.outcome).toBe('passed');
  });

  it('suspended outcome is expressible (verify 挂起不是撤回)', () => {
    const record = AdmissionVerificationRecord.parse({
      revision_id: 'rev_7',
      revision_digest: 'sha256:rev7',
      policy_id: 'admission-policy@2026-09-24',
      generation: 4,
      outcome: 'suspended',
      recorded_at: '2026-09-25T06:15:00.000Z',
    });
    expect(record.outcome).toBe('suspended');
  });
});

describe('LifecycleQualification — draft_status 语义拆分为独立维度', () => {
  it('container-only + no revision + withheld scoring can coexist (旧 draft_status 无法表达)', () => {
    const lifecycle = LifecycleQualification.parse({
      has_published_revision: false,
      scoring_admission: { state: 'withheld', reason: 'unverified_rules', detail: '' },
      availability: 'container_only',
      suspension: { suspended: false, reason: null },
      withdrawal: { withdrawn: false, withdrawn_at: null },
    });
    expect(lifecycle.availability).toBe('container_only');
    expect(lifecycle.has_published_revision).toBe(false);
    expect(lifecycle.scoring_admission.state).toBe('withheld');
  });

  it('verify suspension is independent of withdrawal (挂起 ≠ 撤回)', () => {
    const suspended = LifecycleQualification.parse({
      has_published_revision: true,
      scoring_admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
        admitted_at: '2026-09-24T00:00:00.000Z',
        generation: 1,
      },
      availability: 'general_pool',
      suspension: { suspended: true, reason: 'verify_hold' },
      withdrawal: { withdrawn: false, withdrawn_at: null },
    });
    expect(suspended.suspension.suspended).toBe(true);
    expect(suspended.withdrawal.withdrawn).toBe(false);
  });

  it('dimensions are required — partial lifecycle rows do not parse', () => {
    expect(() =>
      LifecycleQualification.parse({
        has_published_revision: true,
        scoring_admission: { state: 'withheld', reason: 'owner_hold', detail: '' },
        availability: 'general_pool',
        // suspension / withdrawal 缺席 —— 拆分后的维度不可省略
      }),
    ).toThrow();
  });
});

describe('PublishDecision — claim 政策随发布原子落库', () => {
  it('one_time claim policy is a first-class publish decision', () => {
    const decision = PublishDecision.parse({
      lifecycle: {
        has_published_revision: true,
        scoring_admission: {
          state: 'admitted',
          evidence: {
            marking_provenance: 'system_verified',
            verification: {
              structural_check_passed: true,
              independent_verification: {
                passed: true,
                verifier: 'human',
                verified_at: '2026-09-25T06:00:00.000Z',
              },
            },
            model_slice: null,
          },
          admitted_at: '2026-09-25T06:05:00.000Z',
          generation: 0,
        },
        availability: 'container_only',
        suspension: { suspended: false, reason: null },
        withdrawal: { withdrawn: false, withdrawn_at: null },
      },
      issuance_claim_policy: 'one_time',
    });
    expect(decision.issuance_claim_policy).toBe('one_time');
  });
});
