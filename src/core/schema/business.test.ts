// YUK-406 Phase 0 / YUK-440 A13 — ConjectureDraft schema unit tests.

import { describe, expect, it } from 'vitest';

import {
  ConjectureAbstainDraft,
  ConjectureDraft,
  LearningItemOpenStatus,
  LearningItemStatus,
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
    probe_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
    probe_reference_md: "f'(x)=2x·cos(x^2)；外层 cos·内层 2x（链式：外导 × 内导）。",
    followup_probe_md: "对 g(x)=cos(x^3)，写出 g'(x) 并标出内层导数。",
    followup_probe_reference_md: "g'(x)=-3x^2·sin(x^3)；内层导数是 3x²。",
    cause_category: 'concept_confusion',
    recurrence_count: 3,
    predicted_p: 0.35,
    discriminating: true,
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

  it('keeps orchestration-only reasons out of model output while accepting the final decision', () => {
    const sampleFailure = {
      kind: 'abstain' as const,
      reason_code: 'sample_failure' as const,
    };
    expect(ConjectureDraft.safeParse(sampleFailure).success).toBe(false);
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
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_md: '解方程 2x+3=7',
        followup_probe_md: '解方程 2x-3=7',
      }).success,
    ).toBe(true);
    expect(
      ConjectureDraft.safeParse({
        ...valid,
        probe_md: '判断 x/y 的定义域',
        followup_probe_md: '判断 xy 的定义域',
      }).success,
    ).toBe(true);
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

  it('requires discriminating to be a boolean (confused-with-X gate)', () => {
    const { discriminating: _omit, ...rest } = valid;
    expect(ConjectureDraft.safeParse(rest).success).toBe(false);
    expect(ConjectureDraft.safeParse({ ...valid, discriminating: 'yes' }).success).toBe(false);
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
