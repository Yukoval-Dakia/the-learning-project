// YUK-406 Phase 0 — unit tests for deterministic 取证 (no DB / no LLM).

import type { FailureAttempt } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';
import { describe, expect, it } from 'vitest';

import {
  CONJECTURE_RECURRENCE_FLOOR,
  LOW_PRECISION_THRESHOLD,
  conjectureKey,
  gatherConjectureEvidence,
} from './evidence';

function failure(
  id: string,
  knowledgeIds: string[],
  cause: { source: 'user' | 'agent'; category: string },
): FailureAttempt {
  const correction_state = {
    terminal_state: 'active',
    effective_event_id: id,
  } as FailureAttempt['correction_state'];
  const base: FailureAttempt = {
    attempt_event_id: id,
    question_id: `q_${id}`,
    answer_md: null,
    answer_image_refs: [],
    referenced_knowledge_ids: knowledgeIds,
    created_at: new Date('2026-06-18T00:00:00Z'),
    correction_state,
  };
  if (cause.source === 'user') {
    base.user_cause = {
      user_cause_event_id: `uc_${id}`,
      primary_category: cause.category,
      user_notes: null,
      created_at: base.created_at,
      correction_state,
    };
  } else {
    base.judge = {
      judge_event_id: `j_${id}`,
      cause: {
        primary_category: cause.category,
        secondary_categories: [],
        analysis_md: 'agent analysis',
        confidence: 0.6,
      } as NonNullable<FailureAttempt['judge']>['cause'],
      referenced_knowledge_ids: knowledgeIds,
      created_at: base.created_at,
      correction_state,
    };
  }
  return base;
}

function projection(mastery: number, thetaHat: number, thetaPrecision: number): MasteryProjection {
  return {
    mastery,
    mastery_lo: Math.max(0, mastery - 0.1),
    mastery_hi: Math.min(1, mastery + 0.1),
    low_confidence: thetaPrecision < LOW_PRECISION_THRESHOLD,
    theta_hat: thetaHat,
    theta_precision: thetaPrecision,
    theta_se: 1 / Math.sqrt(Math.max(thetaPrecision, 1e-9)),
    evidence_count: 3,
    success_count: 1,
    fail_count: 2,
    last_outcome_at: new Date('2026-06-18T00:00:00Z'),
  };
}

describe('gatherConjectureEvidence — aggregation + recurrence floor', () => {
  it('keeps only cells with recurrence_count >= floor', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_chain_rule'], { source: 'agent', category: 'concept_misapplied' }),
      failure('a2', ['k_chain_rule'], { source: 'agent', category: 'concept_misapplied' }),
      // single occurrence — below floor, must be dropped
      failure('a3', ['k_limits'], { source: 'agent', category: 'concept_misapplied' }),
    ];

    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });

    expect(cells).toHaveLength(1);
    expect(cells[0].cause_category).toBe('concept_misapplied');
    expect(cells[0].knowledge_id).toBe('k_chain_rule');
    expect(cells[0].recurrence_count).toBe(2);
    expect(cells[0].recurrence_count).toBeGreaterThanOrEqual(CONJECTURE_RECURRENCE_FLOOR);
    expect(cells[0].key).toBe(conjectureKey('concept_misapplied', 'k_chain_rule'));
    expect(cells[0].evidence_event_ids).toEqual(['a1', 'a2']);
    // cold start (no mastery row) → null θ + null baseline, probe_here true
    expect(cells[0].theta_hat).toBeNull();
    expect(cells[0].baseline_p).toBeNull();
    expect(cells[0].probe_here).toBe(true);
  });
});

describe('gatherConjectureEvidence — multi-KC fan-out', () => {
  it('counts each KC separately and dedups attempt ids per cell', () => {
    const attempts: FailureAttempt[] = [
      // one attempt referencing two KCs ⇒ contributes to two cells
      failure('a1', ['k_chain_rule', 'k_product_rule'], {
        source: 'agent',
        category: 'concept_misapplied',
      }),
      failure('a2', ['k_chain_rule'], { source: 'agent', category: 'concept_misapplied' }),
      failure('a3', ['k_product_rule'], { source: 'agent', category: 'concept_misapplied' }),
    ];

    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });

    const byKey = new Map(cells.map((c) => [c.key, c]));
    expect(byKey.get(conjectureKey('concept_misapplied', 'k_chain_rule'))?.recurrence_count).toBe(
      2,
    );
    expect(byKey.get(conjectureKey('concept_misapplied', 'k_product_rule'))?.recurrence_count).toBe(
      2,
    );
  });

  it('skips attempts with no active effective cause', () => {
    const noCause = failure('a1', ['k_x'], { source: 'agent', category: 'concept_misapplied' });
    // strip the judge so effectiveCauseForFailureAttempt returns null
    noCause.judge = undefined;
    const cells = gatherConjectureEvidence({
      failures: [noCause, noCause],
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });
    expect(cells).toHaveLength(0);
  });
});

describe('gatherConjectureEvidence — theta/baseline attach, dedup, ordering', () => {
  it('attaches theta + baseline_p and flags low-precision (and unknown) KCs as probe_here', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_low'], { source: 'agent', category: 'concept_misapplied' }),
      failure('a2', ['k_low'], { source: 'agent', category: 'concept_misapplied' }),
      failure('b1', ['k_high'], { source: 'agent', category: 'procedure_slip' }),
      failure('b2', ['k_high'], { source: 'agent', category: 'procedure_slip' }),
      failure('c1', ['k_unknown'], { source: 'agent', category: 'recall_gap' }),
      failure('c2', ['k_unknown'], { source: 'agent', category: 'recall_gap' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map([
        ['k_low', projection(0.3, -0.5, LOW_PRECISION_THRESHOLD - 0.5)],
        ['k_high', projection(0.8, 1.2, LOW_PRECISION_THRESHOLD + 5)],
      ]),
      knownConjectureKeys: new Set(),
    });
    const byKey = new Map(cells.map((c) => [c.key, c]));
    const low = byKey.get(conjectureKey('concept_misapplied', 'k_low'));
    const high = byKey.get(conjectureKey('procedure_slip', 'k_high'));
    const unknown = byKey.get(conjectureKey('recall_gap', 'k_unknown'));
    expect(low?.theta_hat).toBe(-0.5);
    expect(low?.baseline_p).toBe(0.3);
    expect(low?.probe_here).toBe(true);
    expect(high?.baseline_p).toBe(0.8);
    expect(high?.probe_here).toBe(false);
    expect(unknown?.theta_hat).toBeNull();
    expect(unknown?.theta_precision).toBeNull();
    expect(unknown?.baseline_p).toBeNull();
    expect(unknown?.probe_here).toBe(true); // unknown mastery ⇒ probe
  });

  it('skips cells whose key is already known (pending-conjecture dedup)', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_x'], { source: 'agent', category: 'concept_misapplied' }),
      failure('a2', ['k_x'], { source: 'agent', category: 'concept_misapplied' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set([conjectureKey('concept_misapplied', 'k_x')]),
    });
    expect(cells).toHaveLength(0);
  });

  it('orders by recurrence DESC, then probe_here first, then key ASC', () => {
    const attempts: FailureAttempt[] = [
      // recurrence 3 cell
      failure('a1', ['k_a'], { source: 'agent', category: 'cat_a' }),
      failure('a2', ['k_a'], { source: 'agent', category: 'cat_a' }),
      failure('a3', ['k_a'], { source: 'agent', category: 'cat_a' }),
      // recurrence 2 cell, probe_here false (high precision)
      failure('b1', ['k_b'], { source: 'agent', category: 'cat_b' }),
      failure('b2', ['k_b'], { source: 'agent', category: 'cat_b' }),
      // recurrence 2 cell, probe_here true (unknown mastery)
      failure('c1', ['k_c'], { source: 'agent', category: 'cat_c' }),
      failure('c2', ['k_c'], { source: 'agent', category: 'cat_c' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map([['k_b', projection(0.9, 0, LOW_PRECISION_THRESHOLD + 5)]]),
      knownConjectureKeys: new Set(),
    });
    expect(cells.map((c) => c.knowledge_id)).toEqual(['k_a', 'k_c', 'k_b']);
  });

  it('sets has_owner_cause when any contributing attempt has a user cause', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_x'], { source: 'agent', category: 'concept_misapplied' }),
      failure('a2', ['k_x'], { source: 'user', category: 'concept_misapplied' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });
    expect(cells).toHaveLength(1);
    expect(cells[0].has_owner_cause).toBe(true);
  });
});
