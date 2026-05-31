// P5.4 / YUK-143 — pure (no-DB) unit coverage for the rubric validator's
// stable contract: the single-source evidence-window constant and the
// RubricVerdict union / gate string set that YUK-174 (Layer 2) depends on
// (RB-9). The gate-behavior tests that need a real knowledge graph + evidence
// events live in the DB partition (rubric-validator.test.ts).

import { describe, expect, it } from 'vitest';
import {
  RUBRIC_EVIDENCE_WINDOW_DAYS,
  type RubricGate,
  type RubricVerdict,
} from './rubric-validator';

describe('rubric-validator — stable contract (pure)', () => {
  it('RUBRIC_EVIDENCE_WINDOW_DAYS is the single-source 30-day window', () => {
    // knowledge.md §4.2 "recent window: 30 days" (RB-5). Asserting the value
    // here pins the single source; the DB tests import the same const rather
    // than hardcoding 30.
    expect(RUBRIC_EVIDENCE_WINDOW_DAYS).toBe(30);
  });

  it('RubricVerdict ok=true and ok=false shapes type-check', () => {
    const ok: RubricVerdict = { ok: true };
    const rejected: RubricVerdict = {
      ok: false,
      gate: 'evidence_missing',
      reason: 'no evidence',
    };
    expect(ok.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(typeof rejected.gate).toBe('string');
      expect(typeof rejected.reason).toBe('string');
    }
  });

  it('locks the gate string set for Layer-2 stability (RB-9)', () => {
    // A change to this set is a breaking change for YUK-174 and must be
    // intentional. The list mirrors spec §3.4 exactly.
    const gates: RubricGate[] = [
      'self_edge',
      'unknown_node',
      'cross_subject',
      'parent_semantic_duplicate',
      'duplicate_live_edge',
      'duplicate_pending',
      'reasoning_generic',
      'evidence_missing',
      'evidence_level',
      'prerequisite_no_order_evidence',
      'contrasts_with_no_confusion',
      'applied_in_role_mismatch',
      'related_to_dumping_ground',
    ];
    expect(gates).toMatchInlineSnapshot(`
      [
        "self_edge",
        "unknown_node",
        "cross_subject",
        "parent_semantic_duplicate",
        "duplicate_live_edge",
        "duplicate_pending",
        "reasoning_generic",
        "evidence_missing",
        "evidence_level",
        "prerequisite_no_order_evidence",
        "contrasts_with_no_confusion",
        "applied_in_role_mismatch",
        "related_to_dumping_ground",
      ]
    `);
  });
});
