// YUK-531 PR-3 — pure (no-DB) unit for the deterministic misconception id key and the
// neutral default weight const. Both are pure helpers; the live UPSERT / cross-proposal
// collapse + the NaN-confidence guard's runtime behaviour are covered against real rows
// in conjecture-accept.db.test.ts (db partition).
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MISCONCEPTION_WEIGHT,
  misconceptionIdForConjecture,
} from '@/capabilities/agency/server/misconception-promote';

describe('misconceptionIdForConjecture', () => {
  it('is deterministic — same cause×KC ⇒ same id (the cross-proposal collapse key)', () => {
    const a = misconceptionIdForConjecture('concept_misunderstanding', 'kn_chain_rule');
    const b = misconceptionIdForConjecture('concept_misunderstanding', 'kn_chain_rule');
    expect(a).toBe(b);
    expect(a).toMatch(/^misc_[0-9a-f]{24}$/);
  });

  it('is identity-keyed on (cause_category, knowledge_id) — a different cell ⇒ a different id', () => {
    const base = misconceptionIdForConjecture('concept_misunderstanding', 'kn_chain_rule');
    // Different cause, same KC.
    expect(misconceptionIdForConjecture('procedural_slip', 'kn_chain_rule')).not.toBe(base);
    // Same cause, different KC.
    expect(misconceptionIdForConjecture('concept_misunderstanding', 'kn_product_rule')).not.toBe(
      base,
    );
  });
});

describe('DEFAULT_MISCONCEPTION_WEIGHT', () => {
  it('is a neutral mid-confidence prior inside the [0,1] salience band', () => {
    expect(DEFAULT_MISCONCEPTION_WEIGHT).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_MISCONCEPTION_WEIGHT).toBeLessThanOrEqual(1);
    expect(DEFAULT_MISCONCEPTION_WEIGHT).toBe(0.5);
  });
});
