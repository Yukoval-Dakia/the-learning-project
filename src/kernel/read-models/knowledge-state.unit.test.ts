import { expect, it } from 'vitest';
import type { KnowledgeStateJudgment } from './knowledge-state';
import { projectKnowledgeState } from './knowledge-state';

const asOf = new Date('2026-11-07T00:00:00.000Z');

function state(patch: unknown): KnowledgeStateJudgment {
  return patch as KnowledgeStateJudgment;
}

const unknownState = state({
  ability: { kind: 'unknown', reason: 'insufficient_evidence' },
  ability_claim: { kind: 'insufficient_evidence', reason: 'insufficient_evidence' },
  retention: { kind: 'unknown', reason: 'missing_scheduling_state' },
  review_timing: {
    freshness: {
      decay_bucket: 'unknown',
      due_at: { kind: 'unknown', reason: 'missing_scheduling_state' },
    },
  },
});

const knownState = state({
  ability: {
    kind: 'available',
    reading: {
      mastery: 0.5,
      mastery_lo: 0.4,
      mastery_hi: 0.6,
      low_confidence: false,
      evidence_count: 4,
    },
  },
  ability_claim: { kind: 'observed', rule: { low: 0.4 }, calibration: 'uncalibrated' },
  retention: { kind: 'available', engine: 'fsrs', reading: 0 },
  review_timing: {
    freshness: {
      decay_bucket: 'fresh',
      due_at: { kind: 'known', at: new Date('2026-11-08T00:00:00.000Z') },
    },
  },
});

// @invariant grading: one knowledge point's band, evidence, decay, due and retention repeat the published judgment, and an unknown stays null
// @fails-if a missing mastery, decay, due or retention reading is filled in as zero or as the 萌芽 band
it('keeps an unknown judgment null and repeats a known reading', () => {
  const missing = projectKnowledgeState(unknownState, asOf);
  expect(missing.band).toMatchObject({
    known: false,
    value: null,
    missingReason: 'insufficient_evidence',
  });
  expect(missing.evidence_count.value).toBeNull();
  expect(missing.decay.value).toBeNull();
  expect(missing.due_at).toMatchObject({ known: false, value: null });
  expect(missing.retention.value).toBeNull();

  const known = projectKnowledgeState(knownState, asOf);
  expect(known.band).toMatchObject({ known: true, value: '成长' });
  expect(known.evidence_count).toMatchObject({ known: true, value: 4 });
  expect(known.decay).toMatchObject({ known: true, value: 'fresh' });
  expect(known.due_at.value).toBe('2026-11-08T00:00:00.000Z');
  expect(known.retention).toMatchObject({ known: true, value: 0 });
  expect(projectKnowledgeState(knownState, asOf)).toEqual(known);

  const noCard = projectKnowledgeState(
    state({
      ...knownState,
      review_timing: { freshness: { decay_bucket: 'fresh', due_at: { kind: 'absent' } } },
    }),
    asOf,
  );
  expect(noCard.due_at).toMatchObject({ known: true, value: null, missingReason: null });
});
