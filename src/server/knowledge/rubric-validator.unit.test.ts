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
    //
    // PR #219 review fix — `as const satisfies readonly RubricGate[]` makes the
    // array members type-checked against RubricGate, and the two Exclude
    // assertions below turn ANY divergence (a gate added to / removed from the
    // union without updating this array) into a COMPILE error, not just a runtime
    // snapshot mismatch. AssertNever<T> resolves to `never` only when T is
    // `never`, so a non-empty Exclude is a type error at the call site.
    const gates = [
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
    ] as const satisfies readonly RubricGate[];

    // Compile-time completeness: every RubricGate is listed (no member missing)
    // AND no listed member is outside RubricGate (no stale member). Both Excludes
    // must be `never` or this stops compiling.
    type Missing = Exclude<RubricGate, (typeof gates)[number]>;
    type Extra = Exclude<(typeof gates)[number], RubricGate>;
    type AssertNever<T extends never> = T;
    type _MissingIsNever = AssertNever<Missing>;
    type _ExtraIsNever = AssertNever<Extra>;

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
