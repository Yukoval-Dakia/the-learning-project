// YUK-440 (A13) U8 — reconcile loop unit tests. Fully injected deps (no DB).
// Locks the prediction-grounding contract AND the FLIP-inert red-lines:
//   - scorePrediction LOGS a comparison, NEVER moves a label/`mastered` (ADR-0046);
//   - retrievability R(t) is recorded in the prediction_score EVENT only, never in
//     the written kc_typed_state (which has no R column — fold-replayable);
//   - this loop NEVER writes FSRS (ND-5);
//   - a missing / malformed / non-conjecture proposal is SKIPPED (parse-barrier),
//     never throws the whole nightly run.

import type { Db } from '@/db/client';
import type { UpsertKcTypedStateInput } from '@/server/conjectures/typed-state';
import type { WriteEventInput } from '@/server/events/queries';
import { describe, expect, it, vi } from 'vitest';

import {
  PREDICTION_SCORE_ACTION,
  type ReconcileDeps,
  type UnscoredProbeResult,
  reconcileConjecturePredictions,
} from './reconcile';

const DB = {} as Db;

/** A stored conjecture proposal event (writeAiProposal shape: payload.ai_proposal). */
function conjectureEvent(over: Record<string, unknown> = {}) {
  return {
    payload: {
      ai_proposal: {
        kind: 'conjecture',
        target: { subject_kind: 'mind_model', subject_id: 'k_a' },
        reason_md: '你把链式法则当导数相乘',
        evidence_refs: [{ kind: 'event', id: 'att_1' }],
        proposed_change: {
          claim_md: '你把链式法则当导数相乘',
          knowledge_id: 'k_a',
          cause_category: 'concept_confusion',
          confidence: 0.66,
          recurrence_count: 3,
          probe_md: 'probe text',
          discriminating: true,
          corrected_by_owner: false,
          predicted_p: 0.3,
          baseline_p_at_induction: 0.7,
          ...over,
        },
      },
    },
  };
}

function probe(over: Partial<UnscoredProbeResult> = {}): UnscoredProbeResult {
  return {
    probe_result_event_id: 'pr_1',
    conjecture_event_id: 'cj_1',
    outcome: 0,
    resolution: 'confirmed',
    retrievability_at_judge: null,
    created_at: new Date('2026-06-26T10:00:00Z'),
    ...over,
  };
}

function baseDeps(over: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps;
  events: WriteEventInput[];
  upserts: UpsertKcTypedStateInput[];
} {
  const events: WriteEventInput[] = [];
  const upserts: UpsertKcTypedStateInput[] = [];
  const deps: ReconcileDeps = {
    now: () => new Date('2026-06-27T00:00:00Z'),
    listUnscoredProbeResultsFn: vi.fn(async () => [probe()]),
    getEventByIdFn: vi.fn(async () => conjectureEvent()),
    writeEventFn: vi.fn(async (_db: Db, input: WriteEventInput) => {
      events.push(input);
      return input.id;
    }),
    upsertKcTypedStateFn: vi.fn(async (_db: Db, input: UpsertKcTypedStateInput) => {
      upserts.push(input);
    }),
    ...over,
  };
  return { deps, events, upserts };
}

describe('reconcileConjecturePredictions (U8 — A13 dark-loop consumer)', () => {
  it('scores an unscored probe → appends ONE prediction_score event + one typed-state upsert', async () => {
    const { deps, events, upserts } = baseDeps();
    const result = await reconcileConjecturePredictions(DB, deps);

    expect(result).toEqual({ reconciled: 1, skipped: 0 });
    expect(events).toHaveLength(1);
    expect(upserts).toHaveLength(1);

    const ev = events[0];
    expect(ev.action).toBe(PREDICTION_SCORE_ACTION);
    // Idempotency anchor: the score event is keyed on the probe_result event id.
    expect(ev.subject_kind).toBe('event');
    expect(ev.subject_id).toBe('pr_1');
    expect(ev.caused_by_event_id).toBe('pr_1');
    // NOT an attempt — envelope outcome must never carry a 0|1 like a graded answer.
    expect(ev.outcome ?? null).toBeNull();
  });

  it('prediction_score payload carries the proper-scoring breakdown (predicted 0.3, baseline 0.7, outcome 0)', async () => {
    const { deps, events } = baseDeps();
    await reconcileConjecturePredictions(DB, deps);
    const p = events[0].payload as Record<string, number | string>;
    expect(p.conjecture_event_id).toBe('cj_1');
    expect(p.probe_result_event_id).toBe('pr_1');
    expect(p.knowledge_id).toBe('k_a');
    expect(p.predicted_p).toBe(0.3);
    expect(p.baseline_p).toBe(0.7);
    expect(p.outcome).toBe(0);
    // Brier: (0.3-0)^2 = 0.09 ; baseline (0.7-0)^2 = 0.49 ; skill = 1 - 0.09/0.49 > 0 (beat baseline).
    expect(p.brier_model).toBeCloseTo(0.09, 9);
    expect(p.brier_baseline).toBeCloseTo(0.49, 9);
    expect(p.skill_score_point as number).toBeGreaterThan(0);
  });

  it('RED-LINE: upsert is FLIP-inert — confused_with null → soft, never `mastered`, no FSRS', async () => {
    const { deps, upserts } = baseDeps();
    await reconcileConjecturePredictions(DB, deps);
    const u = upserts[0];
    expect(u.subject_id).toBe('k_a');
    expect(u.subject_kind).toBe('knowledge');
    // confirmed → proposes confused-with-X, but the conjecture names no X → null →
    // §修正-4 gate keeps it soft. The reconcile NEVER supplies a confused_with KC in Phase 0.
    expect(u.proposed).toBe('confused-with-X');
    expect(u.confused_with_kc_id).toBeNull();
    expect(u.discriminating).toBe(true);
    expect(u.recurrence_count).toBe(3);
    // evidence append-union = conjecture event + probe_result event (provenance back-link).
    expect(u.evidence_event_ids).toEqual(['cj_1', 'pr_1']);
    // last_evidence_at = the probe judging time (the new evidence's timestamp).
    expect(u.last_evidence_at.getTime()).toBe(new Date('2026-06-26T10:00:00Z').getTime());
    // No 'mastered' field is ever asked for; the upsert input has no FSRS/retrievability key.
    expect('mastered' in u).toBe(false);
  });

  it('RED-LINE: R(t) lands in the prediction_score EVENT, never in the written typed-state', async () => {
    const { deps, events, upserts } = baseDeps({
      listUnscoredProbeResultsFn: vi.fn(async () => [probe({ retrievability_at_judge: 0.42 })]),
    });
    await reconcileConjecturePredictions(DB, deps);
    expect((events[0].payload as Record<string, unknown>).retrievability_at_judge).toBe(0.42);
    // typed-state has no retrievability concept — assert it never leaks into the writer.
    expect('retrievability_at_judge' in upserts[0]).toBe(false);
    expect('retrievabilityAtJudge' in upserts[0]).toBe(false);
  });

  it('maps a retired probe → proposed no-evidence (no confusion claim)', async () => {
    const { deps, upserts } = baseDeps({
      listUnscoredProbeResultsFn: vi.fn(async () => [probe({ resolution: 'retired', outcome: 1 })]),
    });
    await reconcileConjecturePredictions(DB, deps);
    expect(upserts[0].proposed).toBe('no-evidence');
  });

  it('skips a probe whose conjecture event is missing (dangling ref → skip, never throw)', async () => {
    const { deps, events, upserts } = baseDeps({
      getEventByIdFn: vi.fn(async () => null),
    });
    const result = await reconcileConjecturePredictions(DB, deps);
    expect(result).toEqual({ reconciled: 0, skipped: 1 });
    expect(events).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('skips (never throws) when the conjecture READ throws — poison-pill guard (review fix)', async () => {
    // getEventById parse-throws on a corrupt row; the loop must degrade to a counted skip,
    // NOT abort the whole nightly run (which also gates the propose half).
    const { deps, events, upserts } = baseDeps({
      getEventByIdFn: vi.fn(async () => {
        throw new Error('parseEvent: corrupt referenced row');
      }),
    });
    const result = await reconcileConjecturePredictions(DB, deps);
    expect(result).toEqual({ reconciled: 0, skipped: 1 });
    expect(events).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('writes the typed-ledger upsert BEFORE the prediction_score anchor (idempotency order, review fix)', async () => {
    const order: string[] = [];
    const { deps } = baseDeps({
      upsertKcTypedStateFn: vi.fn(async () => {
        order.push('upsert');
      }),
      writeEventFn: vi.fn(async (_db: Db, input: WriteEventInput) => {
        order.push('event');
        return input.id;
      }),
    });
    await reconcileConjecturePredictions(DB, deps);
    // Anchor (prediction_score) must land LAST so "score exists ⟹ ledger advanced" holds.
    expect(order).toEqual(['upsert', 'event']);
  });

  it('skips a malformed conjecture payload (parse-barrier — out-of-range predicted_p)', async () => {
    const { deps, events, upserts } = baseDeps({
      getEventByIdFn: vi.fn(async () => conjectureEvent({ predicted_p: 9 })),
    });
    const result = await reconcileConjecturePredictions(DB, deps);
    expect(result).toEqual({ reconciled: 0, skipped: 1 });
    expect(events).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it('skips a non-conjecture proposal event (wrong kind → skip)', async () => {
    const { deps } = baseDeps({
      getEventByIdFn: vi.fn(async () => ({
        payload: {
          ai_proposal: {
            kind: 'knowledge_node',
            target: { subject_kind: 'knowledge', subject_id: 'k_a' },
            reason_md: 'x',
            evidence_refs: [],
            proposed_change: { name: 'new kc', parent_id: null },
          },
        },
      })),
    });
    const result = await reconcileConjecturePredictions(DB, deps);
    expect(result).toEqual({ reconciled: 0, skipped: 1 });
  });

  it('processes only what the reader returns (idempotency lives in the reader filter)', async () => {
    const listFn = vi.fn(async () => [] as UnscoredProbeResult[]);
    const { deps, events, upserts } = baseDeps({ listUnscoredProbeResultsFn: listFn });
    const result = await reconcileConjecturePredictions(DB, deps);
    expect(result).toEqual({ reconciled: 0, skipped: 0 });
    expect(events).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(listFn).toHaveBeenCalledTimes(1);
  });
});
