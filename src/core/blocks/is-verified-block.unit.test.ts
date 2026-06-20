import { describe, expect, it } from 'vitest';

import { isVerifiedBlock } from './is-verified-block';

// RED-4 (YUK-358, ADR-0040 决定7, rider-1) — the cross-subject verified-block
// detector. A block is user-owned (protected) when the human explicitly verified
// it (`attrs.user_verified === true`) OR its provenance tier is `user_verified`
// (NoteSection.source_tier). Both call sites (apply-note-patch.ts, note-refine-
// policy.ts) import THIS fn so the口径 stays single-sourced.
describe('isVerifiedBlock', () => {
  it('user_verified:true → true', () => {
    expect(isVerifiedBlock({ attrs: { id: 'b1', user_verified: true } })).toBe(true);
  });

  it('source_tier:"user_verified" → true (no user_verified flag)', () => {
    expect(isVerifiedBlock({ attrs: { id: 'b1', source_tier: 'user_verified' } })).toBe(true);
  });

  it('neither flag nor tier → false', () => {
    expect(isVerifiedBlock({ attrs: { id: 'b1', source_tier: 'llm_only' } })).toBe(false);
  });

  it('non-object attrs (null) → false', () => {
    expect(isVerifiedBlock({ attrs: null })).toBe(false);
  });

  it('non-object attrs (array) → false', () => {
    expect(isVerifiedBlock({ attrs: ['user_verified'] })).toBe(false);
  });

  it('missing attrs → false', () => {
    expect(isVerifiedBlock({ type: 'paragraph' })).toBe(false);
  });
});
