// YUK-406 Phase 0 / YUK-440 A13 — ConjectureDraft schema unit tests.

import { describe, expect, it } from 'vitest';

import {
  ConjectureAbstainDraft,
  ConjectureDraft,
  ConjectureHypothesisDraft,
  ConjectureProbePackage,
  ConjectureProbeQualityAttempt,
  ConjectureProbeQualityAudit,
  LearningItemOpenStatus,
  LearningItemStatus,
  evaluateConjectureProbePackageStructure,
} from './business';

describe('LearningItemStatus', () => {
  it('keeps practice/supply open statuses inside the canonical lifecycle enum', () => {
    expect(LearningItemOpenStatus.options).toEqual(['pending', 'in_progress']);
    expect(
      LearningItemOpenStatus.options.every((status) => LearningItemStatus.options.includes(status)),
    ).toBe(true);
    expect(LearningItemStatus.options).not.toContain('active');
  });
});

describe('ConjectureDraft', () => {
  const valid = {
    kind: 'proposal' as const,
    claim_md: '你把链式法则当成「导数相乘」，忽略内层函数的代入。',
    knowledge_id: 'k_chain_rule',
    evidence_event_ids: ['attempt_1', 'attempt_2'],
    diagnostic_spec: {
      schema_version: 1 as const,
      target_error_rule_md: '把链式法则的层间组合误作相加。',
      trigger_conditions_md: '题目要求对复合函数求导。',
      scope_boundary_md: '只覆盖层间组合方式，不推断幂法则掌握情况。',
      expected_wrong_answer_signature_md: '把外层导数与内层导数相加。',
    },
    probe_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
    probe_reference_md: "f'(x)=2x·cos(x^2)；外层 cos·内层 2x（链式：外导 × 内导）。",
    followup_probe_md: "对 g(x)=cos(x^3)，写出 g'(x) 并标出内层导数。",
    followup_probe_reference_md: "g'(x)=-3x^2·sin(x^3)；内层导数是 3x²。",
    probe_spec: {
      prompt_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
      reference_md: "f'(x)=2x·cos(x^2)；外层 cos·内层 2x（链式：外导 × 内导）。",
      expected_target_error_answer_md: "f'(x)=cos(x^2)+2x",
      elicits_target_error_reason_md: '必须决定外导与内导的组合方式。',
      context_kind: 'abstract' as const,
      representation_kind: 'symbolic' as const,
    },
    followup_probe_spec: {
      prompt_md: "对 g(x)=cos(x^3)，写出 g'(x) 并标出内层导数。",
      reference_md: "g'(x)=-3x^2·sin(x^3)；内层导数是 3x²。",
      expected_target_error_answer_md: "g'(x)=-sin(x^3)+3x²",
      elicits_target_error_reason_md: '在文字说明中再次要求组合两层导数。',
      context_kind: 'applied' as const,
      representation_kind: 'natural_language' as const,
    },
    probe_quality: {
      schema_version: 2 as const,
      passed: true as const,
      attempts: [
        {
          attempt: 1,
          outcome: 'passed' as const,
          failure_codes: [],
          explanation_md: '两题保持同一触发条件并改变情境和表征。',
          author_task_run_id: 'run_author',
          reviewer_task_run_id: 'run_review',
        },
      ],
      final_review: {
        verdict: 'pass' as const,
        failure_codes: [],
        explanation_md: '题目、参考答案与目标错误签名相互一致。',
      },
      reviewed_package: {
        primary: {
          prompt_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
          reference_md: "f'(x)=2x·cos(x^2)；外层 cos·内层 2x（链式：外导 × 内导）。",
          expected_target_error_answer_md: "f'(x)=cos(x^2)+2x",
          elicits_target_error_reason_md: '必须决定外导与内导的组合方式。',
          context_kind: 'abstract' as const,
          representation_kind: 'symbolic' as const,
        },
        followup: {
          prompt_md: "对 g(x)=cos(x^3)，写出 g'(x) 并标出内层导数。",
          reference_md: "g'(x)=-3x^2·sin(x^3)；内层导数是 3x²。",
          expected_target_error_answer_md: "g'(x)=-sin(x^3)+3x²",
          elicits_target_error_reason_md: '在文字说明中再次要求组合两层导数。',
          context_kind: 'applied' as const,
          representation_kind: 'natural_language' as const,
        },
        predicted_p: 0.35,
      },
    },
    cause_category: 'concept_confusion',
    recurrence_count: 3,
    predicted_p: 0.35,
    discriminating: true as const,
    agreement_count: 2,
  };

  it('accepts a well-formed second-person conjecture with two distinct probes', () => {
    const parsed = ConjectureDraft.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('defaults agreement_count to 1 when omitted (single sample)', () => {
    const { agreement_count: _omit, ...rest } = valid;
    const parsed = ConjectureDraft.parse(rest);
    expect(parsed.kind).toBe('proposal');
    if (parsed.kind !== 'proposal') throw new Error('expected proposal');
    expect(parsed.agreement_count).toBe(1);
  });

  it('accepts a bounded abstain without requiring a fabricated claim or probe', () => {
    expect(
      ConjectureDraft.parse({
        kind: 'abstain',
        reason_code: 'insufficient_evidence',
        explanation_md: '错答之间没有稳定的共同模式。',
        evidence_event_ids: ['attempt_1'],
      }),
    ).toEqual({
      kind: 'abstain',
      reason_code: 'insufficient_evidence',
      explanation_md: '错答之间没有稳定的共同模式。',
      evidence_event_ids: ['attempt_1'],
    });
  });

  it('keeps the induction hypothesis probe-free and freezes a diagnostic spec', () => {
    const parsed = ConjectureHypothesisDraft.parse({
      kind: 'proposal',
      claim_md: valid.claim_md,
      knowledge_id: valid.knowledge_id,
      evidence_event_ids: valid.evidence_event_ids,
      diagnostic_spec: valid.diagnostic_spec,
      cause_category: valid.cause_category,
      recurrence_count: valid.recurrence_count,
    });
    expect(parsed.kind).toBe('proposal');
    expect('probe_md' in parsed).toBe(false);
  });

  it('keeps orchestration-only reasons out of model output while accepting the final decision', () => {
    const sampleFailure = {
      kind: 'abstain' as const,
      reason_code: 'sample_failure' as const,
    };
    expect(ConjectureDraft.safeParse(sampleFailure).success).toBe(false);
    expect(
      ConjectureHypothesisDraft.safeParse({
        kind: 'abstain',
        reason_code: 'no_discriminating_probe',
      }).success,
    ).toBe(false);
    expect(ConjectureAbstainDraft.parse(sampleFailure)).toEqual({
      kind: 'abstain',
      reason_code: 'sample_failure',
      evidence_event_ids: [],
    });
  });

  it('rejects recurrence_count < 2 (a conjecture needs >=2 distinct attempts)', () => {
    expect(ConjectureDraft.safeParse({ ...valid, recurrence_count: 1 }).success).toBe(false);
  });

  it('rejects an empty probe_md (two discriminating probes are required)', () => {
    expect(ConjectureDraft.safeParse({ ...valid, probe_md: '' }).success).toBe(false);
  });

  it('rejects a follow-up that repeats the first probe after identity normalization', () => {
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        followup_probe_md: `  ${valid.probe_md.normalize('NFKC')}！！ `,
      }).success,
    ).toBe(false);
  });

  it('preserves punctuation that changes a mathematical expression', () => {
    const plusMinus = {
      ...valid,
      probe_md: '解方程 2x+3=7',
      followup_probe_md: '解方程 2x-3=7',
      probe_spec: { ...valid.probe_spec, prompt_md: '解方程 2x+3=7' },
      followup_probe_spec: {
        ...valid.followup_probe_spec,
        prompt_md: '解方程 2x-3=7',
      },
      probe_quality: {
        ...valid.probe_quality,
        reviewed_package: {
          ...valid.probe_quality.reviewed_package,
          primary: { ...valid.probe_spec, prompt_md: '解方程 2x+3=7' },
          followup: {
            ...valid.followup_probe_spec,
            prompt_md: '解方程 2x-3=7',
          },
        },
      },
    };
    expect(ConjectureDraft.safeParse(plusMinus).success).toBe(true);
    const quotientProduct = {
      ...valid,
      probe_md: '判断 x/y 的定义域',
      followup_probe_md: '判断 xy 的定义域',
      probe_spec: { ...valid.probe_spec, prompt_md: '判断 x/y 的定义域' },
      followup_probe_spec: {
        ...valid.followup_probe_spec,
        prompt_md: '判断 xy 的定义域',
      },
      probe_quality: {
        ...valid.probe_quality,
        reviewed_package: {
          ...valid.probe_quality.reviewed_package,
          primary: { ...valid.probe_spec, prompt_md: '判断 x/y 的定义域' },
          followup: {
            ...valid.followup_probe_spec,
            prompt_md: '判断 xy 的定义域',
          },
        },
      },
    };
    expect(ConjectureDraft.safeParse(quotientProduct).success).toBe(true);
  });

  it('trims follow-up fields and rejects whitespace-only prompt or reference', () => {
    const parsed = ConjectureDraft.parse({
      ...valid,
      followup_probe_md: `  ${valid.followup_probe_md}  `,
      followup_probe_reference_md: `  ${valid.followup_probe_reference_md}  `,
    });
    if (parsed.kind !== 'proposal') throw new Error('expected proposal');
    expect(parsed.followup_probe_md).toBe(valid.followup_probe_md);
    expect(parsed.followup_probe_reference_md).toBe(valid.followup_probe_reference_md);
    expect(ConjectureDraft.safeParse({ ...valid, followup_probe_md: ' \n\t ' }).success).toBe(
      false,
    );
    expect(
      ConjectureDraft.safeParse({ ...valid, followup_probe_reference_md: ' \n\t ' }).success,
    ).toBe(false);
  });

  it('rejects predicted_p outside [0,1] (A13 falsifiable prediction is a probability)', () => {
    expect(ConjectureDraft.safeParse({ ...valid, predicted_p: 1.5 }).success).toBe(false);
    expect(ConjectureDraft.safeParse({ ...valid, predicted_p: -0.1 }).success).toBe(false);
  });

  it('requires independently reviewed proposals to be discriminating', () => {
    const { discriminating: _omit, ...rest } = valid;
    expect(ConjectureDraft.safeParse(rest).success).toBe(false);
    expect(ConjectureDraft.safeParse({ ...valid, discriminating: 'yes' }).success).toBe(false);
    expect(ConjectureDraft.safeParse({ ...valid, discriminating: false }).success).toBe(false);
  });

  it('rechecks subject-neutral pair independence at the final proposal boundary', () => {
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        followup_probe_spec: {
          ...valid.followup_probe_spec,
          context_kind: valid.probe_spec.context_kind,
          representation_kind: valid.probe_spec.representation_kind,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a passing audit whose final attempt did not pass', () => {
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_quality: {
          ...valid.probe_quality,
          attempts: [
            {
              attempt: 1,
              outcome: 'review_failed',
              failure_codes: ['probe_not_targeting'],
              explanation_md: '目标触发条件丢失。',
              author_task_run_id: 'run_author',
              reviewer_task_run_id: 'run_review',
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('binds a v2 audit to the exact persisted package and requires complete pass lineage', () => {
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_quality: {
          ...valid.probe_quality,
          reviewed_package: {
            ...valid.probe_quality.reviewed_package,
            predicted_p: 0.36,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_quality: {
          ...valid.probe_quality,
          attempts: [
            {
              ...valid.probe_quality.attempts[0],
              reviewer_task_run_id: null,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps v1 audit history readable but rejects it as a new conjecture draft', () => {
    const { reviewed_package: _reviewedPackage, ...historicalAudit } = valid.probe_quality;
    const v1Audit = { ...historicalAudit, schema_version: 1 as const };
    expect(ConjectureProbeQualityAudit.safeParse(v1Audit).success).toBe(true);
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_quality: v1Audit,
      }).success,
    ).toBe(false);
  });

  it('keeps structure, review, and operational attempt codes in separate vocabularies', () => {
    const base = {
      attempt: 1,
      explanation_md: '失败原因。',
      author_task_run_id: 'run_author',
      reviewer_task_run_id: null,
    };
    expect(
      ConjectureProbeQualityAttempt.safeParse({
        ...base,
        outcome: 'structure_failed',
        failure_codes: ['probe_pair_not_independent'],
      }).success,
    ).toBe(true);
    expect(
      ConjectureProbeQualityAttempt.safeParse({
        ...base,
        outcome: 'structure_failed',
        failure_codes: ['author_operational_failure'],
      }).success,
    ).toBe(false);
    expect(
      ConjectureProbeQualityAttempt.safeParse({
        ...base,
        outcome: 'operational_failed',
        failure_codes: ['author_operational_failure'],
      }).success,
    ).toBe(true);
    expect(
      ConjectureProbeQualityAttempt.safeParse({
        ...base,
        outcome: 'operational_failed',
        failure_codes: ['probe_not_targeting'],
      }).success,
    ).toBe(false);
  });

  it('rejects model-authored metadata when the persisted flat prompt/reference diverges', () => {
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_spec: { ...valid.probe_spec, prompt_md: '另一道题' },
      }).success,
    ).toBe(false);
  });

  it('structurally rejects non-independent pairs and target-error answers equal to gold', () => {
    const probePackage = ConjectureProbePackage.parse({
      primary: valid.probe_spec,
      followup: {
        ...valid.followup_probe_spec,
        context_kind: valid.probe_spec.context_kind,
        representation_kind: valid.probe_spec.representation_kind,
        expected_target_error_answer_md: valid.followup_probe_spec.reference_md,
      },
      predicted_p: 0.3,
    });
    expect(evaluateConjectureProbePackageStructure(probePackage)).toEqual([
      'probe_pair_not_independent',
      'target_error_answer_not_distinct',
    ]);
  });

  it('trims producer claims and rejects whitespace-only input', () => {
    const parsed = ConjectureDraft.parse({ ...valid, claim_md: '  有效判断  ' });
    if (parsed.kind !== 'proposal') throw new Error('expected proposal');
    expect(parsed.claim_md).toBe('有效判断');
    expect(ConjectureDraft.safeParse({ ...valid, claim_md: ' \n\t ' }).success).toBe(false);
  });

  // Regression (PR-1 review): claim_md max MUST match ConjectureProposalChange's
  // (proposal.ts, max 280). The draft is the model-facing outputFormat AND feeds
  // straight into the proposal payload — a wider draft would let a 281+ char claim
  // pass induction then throw at the proposal parse-barrier (silently swallowed +
  // mis-logged as a retryable AI failure).
  it('caps claim_md at 280 to match the downstream proposal schema', () => {
    expect(ConjectureDraft.safeParse({ ...valid, claim_md: 'x'.repeat(280) }).success).toBe(true);
    expect(ConjectureDraft.safeParse({ ...valid, claim_md: 'x'.repeat(281) }).success).toBe(false);
  });
});
