// YUK-164 OC-5 — pure-fn unit tests for the auto-enroll review helpers.
// node-only, no render, no DB (lane plan §5). Slice 2 covers formatConfidence +
// banner/revert predicates + seedBlockForm; slice 3 extends seedBlockForm cases.

import { describe, expect, it } from 'vitest';
import {
  type AutoEnrollObservation,
  formatConfidence,
  isRevertable,
  seedBlockForm,
  shouldShowObserveBanner,
} from './auto-enroll';

function obs(overrides: Partial<AutoEnrollObservation> = {}): AutoEnrollObservation {
  return {
    event_id: 'evt_1',
    outcome: null,
    mode: 'observe',
    route: 'auto',
    confidence: 0.5,
    threshold: 0.6,
    reasoning: null,
    suggested_knowledge_ids: [],
    mistake_draft: null,
    observed_at: '2026-06-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatConfidence', () => {
  it('renders mono `confidence X.XX` with two decimals', () => {
    expect(formatConfidence(0.5)).toBe('confidence 0.50');
    expect(formatConfidence(0.873)).toBe('confidence 0.87');
    expect(formatConfidence(1)).toBe('confidence 1.00');
  });

  it('renders a stable placeholder for null / non-finite', () => {
    expect(formatConfidence(null)).toBe('confidence —');
    expect(formatConfidence(undefined)).toBe('confidence —');
    expect(formatConfidence(Number.NaN)).toBe('confidence —');
  });
});

describe('shouldShowObserveBanner', () => {
  it('is true when no loaded block is auto_enrolled (observe-only)', () => {
    expect(
      shouldShowObserveBanner([{ status: 'draft' }, { status: 'imported' }, { status: 'ignored' }]),
    ).toBe(true);
  });

  it('is true for an empty block list (nothing enrolled yet)', () => {
    expect(shouldShowObserveBanner([])).toBe(true);
  });

  it('is false once any loaded block is auto_enrolled (flag ON)', () => {
    expect(shouldShowObserveBanner([{ status: 'draft' }, { status: 'auto_enrolled' }])).toBe(false);
  });
});

describe('isRevertable', () => {
  it('is true only for auto_enrolled blocks', () => {
    expect(isRevertable({ status: 'auto_enrolled' })).toBe(true);
  });

  it('is false for draft / imported / ignored blocks', () => {
    expect(isRevertable({ status: 'draft' })).toBe(false);
    expect(isRevertable({ status: 'imported' })).toBe(false);
    expect(isRevertable({ status: 'ignored' })).toBe(false);
  });
});

describe('seedBlockForm', () => {
  it('returns today’s defaults when there is no observation (regression baseline)', () => {
    expect(seedBlockForm({ auto_enroll_observation: null })).toEqual({
      knowledge_ids: [],
      cause_primary: '',
      cause_notes: '',
      question_kind: 'short_answer',
      difficulty: 3,
    });
  });

  it('seeds knowledge_ids from suggested_knowledge_ids', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({ suggested_knowledge_ids: ['k1', 'k2'] }),
    });
    expect(seed.knowledge_ids).toEqual(['k1', 'k2']);
    // returns a copy, not the source array reference
    expect(seed.knowledge_ids).not.toBe(
      obs({ suggested_knowledge_ids: ['k1', 'k2'] }).suggested_knowledge_ids,
    );
  });

  it('seeds difficulty + cause from mistake_draft', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({
        suggested_knowledge_ids: ['k1'],
        mistake_draft: {
          wrong_answer: 'failure',
          difficulty: 4,
          cause: { primary_category: 'careless', analysis_md: '审题失误' },
        },
      }),
    });
    expect(seed.difficulty).toBe(4);
    expect(seed.cause_primary).toBe('careless');
    // cause_notes maps from analysis_md (NOT a nonexistent user_notes field)
    expect(seed.cause_notes).toBe('审题失误');
  });

  it('falls back to default difficulty + empty cause when mistake_draft is absent', () => {
    const seed = seedBlockForm({ auto_enroll_observation: obs({ mistake_draft: null }) });
    expect(seed.difficulty).toBe(3);
    expect(seed.cause_primary).toBe('');
    expect(seed.cause_notes).toBe('');
  });

  it('seeds empty cause when mistake_draft.cause is null (non-failure outcome)', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({
        mistake_draft: { wrong_answer: 'success', difficulty: 2, cause: null },
      }),
    });
    expect(seed.difficulty).toBe(2);
    expect(seed.cause_primary).toBe('');
    expect(seed.cause_notes).toBe('');
  });

  it('keeps present fields when a legacy mistake_draft omits difficulty', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({
        mistake_draft: {
          wrong_answer: 'failure',
          difficulty: null,
          cause: { primary_category: 'concept', analysis_md: 'x' },
        },
      }),
    });
    // absent difficulty → default; present cause fields → seeded
    expect(seed.difficulty).toBe(3);
    expect(seed.cause_primary).toBe('concept');
    expect(seed.cause_notes).toBe('x');
  });
});

// slice 3 — VisionTab prefill. The seed `useEffect` is a one-line `seedBlockForm`
// call, so the prefill contract is verified here (the effect cannot tick under
// renderToString). These pin the §4 field mapping that the VisionTab seed relies
// on, most critically `cause_notes ← cause.analysis_md` (NOT a `user_notes` field,
// which does not exist on CauseSchema and would not typecheck off the typed cause).
describe('seedBlockForm — VisionTab prefill field mapping (slice 3)', () => {
  it('maps cause_notes from cause.analysis_md (the judge cause text), not user_notes', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({
        suggested_knowledge_ids: ['k1'],
        mistake_draft: {
          wrong_answer: 'failure',
          difficulty: 4,
          cause: { primary_category: 'concept', analysis_md: '把公式记反了' },
        },
      }),
    });
    // cause_notes is sourced from analysis_md verbatim.
    expect(seed.cause_notes).toBe('把公式记反了');
    // and the sibling fields are seeded together (knowledge_ids + cause_primary)
    // so the VisionTab self-heal effect admits the seeded cause.
    expect(seed.knowledge_ids).toEqual(['k1']);
    expect(seed.cause_primary).toBe('concept');
    expect(seed.difficulty).toBe(4);
  });

  it('leaves question_kind at the prefill default (not derived from the observation)', () => {
    const seed = seedBlockForm({
      auto_enroll_observation: obs({
        mistake_draft: {
          wrong_answer: 'partial',
          difficulty: 2,
          cause: { primary_category: 'careless', analysis_md: '审题' },
        },
      }),
    });
    expect(seed.question_kind).toBe('short_answer');
  });
});
