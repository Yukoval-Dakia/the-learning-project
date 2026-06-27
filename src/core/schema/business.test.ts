// YUK-406 Phase 0 / YUK-440 A13 — ConjectureDraft schema unit tests.

import { describe, expect, it } from 'vitest';

import { ConjectureDraft } from './business';

describe('ConjectureDraft', () => {
  const valid = {
    claim_md: '你把链式法则当成「导数相乘」，忽略内层函数的代入。',
    probe_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
    cause_category: 'concept_confusion',
    recurrence_count: 3,
    predicted_p: 0.35,
    discriminating: true,
    agreement_count: 2,
  };

  it('accepts a well-formed second-person conjecture with exactly one probe', () => {
    const parsed = ConjectureDraft.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('defaults agreement_count to 1 when omitted (single sample)', () => {
    const { agreement_count: _omit, ...rest } = valid;
    const parsed = ConjectureDraft.parse(rest);
    expect(parsed.agreement_count).toBe(1);
  });

  it('rejects recurrence_count < 2 (a conjecture needs >=2 distinct attempts)', () => {
    expect(ConjectureDraft.safeParse({ ...valid, recurrence_count: 1 }).success).toBe(false);
  });

  it('rejects an empty probe_md (exactly one discriminating probe required)', () => {
    expect(ConjectureDraft.safeParse({ ...valid, probe_md: '' }).success).toBe(false);
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
